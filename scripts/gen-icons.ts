// Generates PWA icons (original "Sada" echo-wave mark, teal brand).
import sharp from "sharp";

const SIZE = 512;
const svg = (size: number) => `
<svg width="${size}" height="${size}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f766e"/>
      <stop offset="100%" stop-color="#134e4a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <g stroke="#5eead4" stroke-width="34" stroke-linecap="round" fill="none">
    <path d="M136 256 L136 256" stroke-width="40"/>
    <path d="M196 190 L196 322" />
    <path d="M256 140 L256 372" stroke="#fbbf24"/>
    <path d="M316 190 L316 322" />
    <path d="M376 232 L376 280" />
  </g>
</svg>`;

await sharp(Buffer.from(svg(512))).resize(512, 512).png().toFile("public/icons/icon-512.png");
await sharp(Buffer.from(svg(512))).resize(192, 192).png().toFile("public/icons/icon-192.png");
await sharp(Buffer.from(svg(512))).resize(180, 180).png().toFile("public/icons/apple-touch-icon.png");
console.log("icons generated");
