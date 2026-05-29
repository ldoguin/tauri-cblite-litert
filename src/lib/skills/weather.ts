/**
 * weather skill — current conditions + 3-day forecast via Open-Meteo.
 *
 * Two-step: geocode the location name with the Open-Meteo geocoding API,
 * then fetch weather data.  No API key required.
 */
import type { Tool } from "../tools";
import { skillFetch } from "./shared";

// WMO Weather Interpretation Codes (WW)
const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Icy fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm + hail", 99: "Thunderstorm + heavy hail",
};

interface GeoResult {
  name: string; latitude: number; longitude: number;
  country: string; admin1?: string; timezone?: string;
}
interface WeatherCurrent {
  temperature_2m: number; apparent_temperature: number;
  relative_humidity_2m: number; precipitation: number;
  wind_speed_10m: number; wind_gusts_10m: number;
  wind_direction_10m: number; weather_code: number;
  uv_index?: number;
}
interface WeatherDaily {
  time: string[]; weather_code: number[];
  temperature_2m_max: number[]; temperature_2m_min: number[];
  precipitation_sum: number[]; wind_speed_10m_max: number[];
  uv_index_max?: number[];
}

function windDir(deg: number): string {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(deg / 45) % 8];
}

export const weatherTool: Tool = {
  id: "weather",
  name: "Weather",
  description:
    "Gets current weather conditions and a 3-day forecast for any location. " +
    "No API key required (uses Open-Meteo + Open-Meteo Geocoding).",
  requiresNetwork: true,
  params: [
    { name: "location", type: "string", description: 'City or region name, e.g. "Paris", "New York", "Tokyo, Japan"', required: true  },
    { name: "units",    type: "string", description: '"celsius" (default) or "fahrenheit"',                             required: false },
  ],
  async run({ location, units }, signal) {
    if (!location) return "Error: location is required";
    const loc = String(location);
    const fahrenheit = String(units ?? "").toLowerCase().startsWith("f");
    const tUnit = fahrenheit ? "fahrenheit" : "celsius";
    const tSym  = fahrenheit ? "°F" : "°C";

    // ── Step 1: Geocode ────────────────────────────────────────────────────
    const geoUrl =
      `https://geocoding-api.open-meteo.com/v1/search` +
      `?name=${encodeURIComponent(loc)}&count=1&language=en&format=json`;
    const geoBody = await skillFetch(geoUrl, signal);
    const geoData = JSON.parse(geoBody) as { results?: GeoResult[] };
    if (!geoData.results?.length) return `Location "${loc}" not found. Try a larger nearby city.`;
    const place = geoData.results[0];

    // ── Step 2: Weather ────────────────────────────────────────────────────
    const wx =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,` +
      `wind_speed_10m,wind_gusts_10m,wind_direction_10m,weather_code,uv_index` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,` +
      `wind_speed_10m_max,uv_index_max` +
      `&temperature_unit=${tUnit}&wind_speed_unit=kmh&forecast_days=4&timezone=auto`;
    const wxBody = await skillFetch(wx, signal);
    const w = JSON.parse(wxBody) as { current: WeatherCurrent; daily: WeatherDaily };

    const c = w.current;
    const d = w.daily;
    const placeName = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
    const cond = WMO[c.weather_code] ?? `Code ${c.weather_code}`;

    const lines: string[] = [
      `📍 ${placeName}`,
      ``,
      `Current conditions:`,
      `  ${c.temperature_2m}${tSym} (feels like ${c.apparent_temperature}${tSym})`,
      `  ${cond}`,
      `  Humidity: ${c.relative_humidity_2m}%  ·  Precip: ${c.precipitation} mm`,
      `  Wind: ${c.wind_speed_10m} km/h ${windDir(c.wind_direction_10m)} (gusts ${c.wind_gusts_10m} km/h)`,
    ];
    if (c.uv_index !== undefined) lines.push(`  UV Index: ${c.uv_index}`);

    lines.push(``, `Forecast:`);
    for (let i = 0; i < Math.min(4, d.time.length); i++) {
      const day = new Date(d.time[i]).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const dc  = WMO[d.weather_code[i]] ?? "";
      const uvStr = d.uv_index_max ? `  UV ${d.uv_index_max[i]}` : "";
      lines.push(
        `  ${day}: ${d.temperature_2m_min[i]}–${d.temperature_2m_max[i]}${tSym}` +
        `  ${dc}  🌧${d.precipitation_sum[i]}mm  💨${d.wind_speed_10m_max[i]}km/h${uvStr}`
      );
    }
    return lines.join("\n");
  },
};
