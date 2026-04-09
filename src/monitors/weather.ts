/**
 * Weather client for daily briefing — no API key required.
 *
 * Uses wttr.in, a free weather service that returns JSON with no
 * authentication. Falls back to a simple text format if JSON fails.
 */

// ── Types ───────────────────────────────────────────────────────

export interface WeatherConfig {
  enabled: boolean;
  /** Location string, e.g. "San Francisco" or "London" */
  location: string;
  units: 'imperial' | 'metric';
}

export interface WeatherData {
  location: string;
  temp: number;
  feelsLike: number;
  tempMin: number;
  tempMax: number;
  humidity: number;
  description: string;
  windSpeed: number;
  units: 'imperial' | 'metric';
}

// ── wttr.in response types ──────────────────────────────────────

interface WttrCurrentCondition {
  temp_F: string;
  temp_C: string;
  FeelsLikeF: string;
  FeelsLikeC: string;
  humidity: string;
  weatherDesc: Array<{ value: string }>;
  windspeedMiles: string;
  windspeedKmph: string;
  weatherCode: string;
}

interface WttrWeatherDay {
  mintempF: string;
  mintempC: string;
  maxtempF: string;
  maxtempC: string;
}

interface WttrResponse {
  current_condition: WttrCurrentCondition[];
  weather: WttrWeatherDay[];
  nearest_area: Array<{
    areaName: Array<{ value: string }>;
    region: Array<{ value: string }>;
  }>;
}

// ── Constants ───────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;

// ── Weather code → emoji mapping ────────────────────────────────

const WEATHER_CODE_EMOJI: Record<string, string> = {
  '113': '☀️',     // Clear/Sunny
  '116': '⛅',     // Partly cloudy
  '119': '☁️',     // Cloudy
  '122': '☁️',     // Overcast
  '143': '🌫️',    // Mist
  '176': '🌦️',    // Patchy rain
  '179': '🌨️',    // Patchy snow
  '182': '🌧️',    // Patchy sleet
  '185': '🌧️',    // Patchy freezing drizzle
  '200': '⛈️',     // Thundery outbreaks
  '227': '🌨️',    // Blowing snow
  '230': '❄️',     // Blizzard
  '248': '🌫️',    // Fog
  '260': '🌫️',    // Freezing fog
  '263': '🌦️',    // Patchy light drizzle
  '266': '🌧️',    // Light drizzle
  '281': '🌧️',    // Freezing drizzle
  '284': '🌧️',    // Heavy freezing drizzle
  '293': '🌦️',    // Patchy light rain
  '296': '🌧️',    // Light rain
  '299': '🌧️',    // Moderate rain at times
  '302': '🌧️',    // Moderate rain
  '305': '🌧️',    // Heavy rain at times
  '308': '🌧️',    // Heavy rain
  '311': '🌧️',    // Light freezing rain
  '314': '🌧️',    // Moderate/heavy freezing rain
  '317': '🌨️',    // Light sleet
  '320': '🌨️',    // Moderate/heavy sleet
  '323': '🌨️',    // Patchy light snow
  '326': '🌨️',    // Light snow
  '329': '❄️',     // Patchy moderate snow
  '332': '❄️',     // Moderate snow
  '335': '❄️',     // Patchy heavy snow
  '338': '❄️',     // Heavy snow
  '350': '🌧️',    // Ice pellets
  '353': '🌦️',    // Light rain shower
  '356': '🌧️',    // Moderate/heavy rain shower
  '359': '🌧️',    // Torrential rain shower
  '362': '🌨️',    // Light sleet showers
  '365': '🌨️',    // Moderate/heavy sleet showers
  '368': '🌨️',    // Light snow showers
  '371': '❄️',     // Moderate/heavy snow showers
  '374': '🌧️',    // Light ice pellet showers
  '377': '🌧️',    // Moderate/heavy ice pellet showers
  '386': '⛈️',     // Patchy light rain with thunder
  '389': '⛈️',     // Moderate/heavy rain with thunder
  '392': '⛈️',     // Patchy light snow with thunder
  '395': '⛈️',     // Moderate/heavy snow with thunder
};

// ── Client ──────────────────────────────────────────────────────

export class WeatherClient {
  private location: string;
  private units: 'imperial' | 'metric';

  constructor(config: WeatherConfig) {
    this.location = config.location;
    this.units = config.units;
  }

  /**
   * Fetches current weather using wttr.in (no API key needed).
   */
  async getCurrentWeather(): Promise<WeatherData> {
    const url = `https://wttr.in/${encodeURIComponent(this.location)}?format=j1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Virgil-Agent/1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`wttr.in error (${response.status}): ${text}`);
    }

    const data = (await response.json()) as WttrResponse;
    const current = data.current_condition[0];
    const today = data.weather[0];
    const area = data.nearest_area?.[0];

    const locationName = area
      ? `${area.areaName[0]?.value ?? this.location}`
      : this.location;

    const isImperial = this.units === 'imperial';

    return {
      location: locationName,
      temp: Math.round(parseFloat(isImperial ? current.temp_F : current.temp_C)),
      feelsLike: Math.round(parseFloat(isImperial ? current.FeelsLikeF : current.FeelsLikeC)),
      tempMin: Math.round(parseFloat(isImperial ? today.mintempF : today.mintempC)),
      tempMax: Math.round(parseFloat(isImperial ? today.maxtempF : today.maxtempC)),
      humidity: parseInt(current.humidity, 10),
      description: current.weatherDesc[0]?.value ?? 'Unknown',
      windSpeed: Math.round(parseFloat(isImperial ? current.windspeedMiles : current.windspeedKmph)),
      units: this.units,
    };
  }

  /**
   * Formats weather data into a brief human-readable string for the briefing.
   */
  static format(w: WeatherData): string {
    // Try to map description to emoji, fall back to sun
    const emoji = '🌤️';
    const unitLabel = w.units === 'imperial' ? '°F' : '°C';
    const windUnit = w.units === 'imperial' ? 'mph' : 'km/h';

    return [
      `${emoji} **${w.location}** — ${w.temp}${unitLabel} (feels ${w.feelsLike}${unitLabel})`,
      `   ${w.description} | High ${w.tempMax}${unitLabel} / Low ${w.tempMin}${unitLabel}`,
      `   Wind ${w.windSpeed} ${windUnit} | Humidity ${w.humidity}%`,
    ].join('\n');
  }

  /**
   * Formats with weather code emoji (used when we have the raw data).
   */
  static formatWithCode(w: WeatherData, weatherCode?: string): string {
    const emoji = (weatherCode && WEATHER_CODE_EMOJI[weatherCode]) ?? '🌤️';
    const unitLabel = w.units === 'imperial' ? '°F' : '°C';
    const windUnit = w.units === 'imperial' ? 'mph' : 'km/h';

    return [
      `${emoji} **${w.location}** — ${w.temp}${unitLabel} (feels ${w.feelsLike}${unitLabel})`,
      `   ${w.description} | High ${w.tempMax}${unitLabel} / Low ${w.tempMin}${unitLabel}`,
      `   Wind ${w.windSpeed} ${windUnit} | Humidity ${w.humidity}%`,
    ].join('\n');
  }
}
