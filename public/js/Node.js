// generate_qr.js
import QRCode from 'qrcode';
import fs from 'fs';

const hosts = [
  { venueId: "H001", queueId: "Q001", name: "The Louvre", addr: "Rue de Rivoli, Paris", slot: "11:30" },
  { venueId: "H002", queueId: "Q002", name: "British Museum", addr: "London", slot: "12:15" },
  // … add up to 30 hosts
];

hosts.forEach(h => {
  const url = `https://your-app-domain.com/pages/visitor/VirtualQueueSpotBooking.html?venueId=${h.venueId}&queueId=${h.queueId}&name=${encodeURIComponent(h.name)}&addr=${encodeURIComponent(h.addr)}&slot=${h.slot}`;
  QRCode.toFile(`./qr_codes/${h.venueId}.png`, url, {
    width: 300,
    margin: 2
  }, err => {
    if (err) throw err;
    console.log(`✅ QR generated for ${h.name}: ${h.venueId}.png`);
  });
});
