// Sol, clima y lluvia para la demo 3D: todo con la hora y el clima reales del lugar.

const RAD = Math.PI / 180;

// Posición del sol (algoritmo de SunCalc, precisión de minutos): elevación y rumbo en grados,
// rumbo medido desde el norte en sentido horario como la brújula del mapa.
export function sunPosition(date, lat, lng) {
  const days = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
  const M = RAD * (357.5291 + 0.98560028 * days);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  const e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const H = RAD * (280.16 + 360.9856235 * days) - lw - ra;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { elevation: alt / RAD, azimuth: (az / RAD + 180) % 360 };
}

export function phaseFor(elevation) {
  if (elevation > 8) return 'dia';
  if (elevation > -4) return 'atardecer';
  return 'noche';
}

// Códigos WMO que usa Open-Meteo.
export function describeWeather(code) {
  if (code === 0) return { icon: '☀️', text: 'Despejado', kind: 'clear' };
  if (code <= 2) return { icon: '🌤️', text: 'Parcialmente nublado', kind: 'clear' };
  if (code === 3) return { icon: '☁️', text: 'Nublado', kind: 'cloudy' };
  if (code === 45 || code === 48) return { icon: '🌫️', text: 'Niebla', kind: 'fog' };
  if (code >= 51 && code <= 57) return { icon: '🌦️', text: 'Llovizna', kind: 'drizzle' };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: '🌧️', text: code === 65 || code === 82 ? 'Lluvia fuerte' : 'Lluvia', kind: 'rain' };
  if (code >= 95) return { icon: '⛈️', text: 'Tormenta eléctrica', kind: 'storm' };
  return { icon: '🌤️', text: 'Variable', kind: 'clear' };
}

export async function fetchWeather(lat, lng) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m&timezone=America%2FBogota`;
    const res = await fetch(url, { signal: ctrl.signal });
    const c = (await res.json())?.current;
    if (!c || typeof c.weather_code !== 'number') return null;
    return {
      temp: c.temperature_2m,
      humidity: c.relative_humidity_2m,
      precip: c.precipitation,
      code: c.weather_code,
      cloud: c.cloud_cover,
      wind: c.wind_speed_10m,
      windDir: c.wind_direction_10m,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Lluvia dibujada en un lienzo encima del mapa: no depende del motor 3D y se ve igual sobre la
// ciudad fotorrealista y sobre el mapa vectorial.
export class RainLayer {
  constructor(canvas, flash) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.flash = flash;
    this.drops = [];
    this.intensity = 0;
    this.wind = 0.25;
    this.storm = false;
    this.nextBolt = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  set(intensity, storm = false, wind = 0.25) {
    this.intensity = intensity;
    this.storm = storm;
    this.wind = wind;
    const target = Math.round(intensity * 900);
    while (this.drops.length < target) this.drops.push(this.spawn(true));
    this.drops.length = target;
    this.canvas.style.opacity = intensity > 0 ? '1' : '0';
  }

  spawn(anywhere) {
    const z = Math.random();
    return {
      x: Math.random() * (innerWidth + 200) - 100,
      y: anywhere ? Math.random() * innerHeight : -20,
      len: 10 + z * 22,
      speed: 650 + z * 900,
      alpha: 0.15 + z * 0.35,
    };
  }

  draw(dt, now) {
    const { ctx } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!this.intensity) return;
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.1;
    for (const d of this.drops) {
      d.y += d.speed * dt;
      d.x += d.speed * this.wind * dt;
      if (d.y > innerHeight + 30 || d.x > innerWidth + 120) Object.assign(d, this.spawn(false));
      ctx.strokeStyle = `rgba(190, 215, 255, ${d.alpha})`;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - d.len * this.wind, d.y - d.len);
      ctx.stroke();
    }
    if (this.storm && now > this.nextBolt) {
      this.nextBolt = now + 5000 + Math.random() * 9000;
      this.flash();
    }
  }
}
