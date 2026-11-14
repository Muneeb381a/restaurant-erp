// Stands in for @napi-rs/canvas inside the Vercel bundle. That module is a ~50 MB native binary used
// only to draw Urdu receipts as a bitmap for a thermal printer; the cloud deployment has no LAN
// printer to send them to (receipts print from the browser). Nothing calls it; if something ever does,
// it fails loudly instead of the function failing to start.
const unavailable = () => {
  throw new Error('Urdu thermal-printer bitmaps are not available in the cloud deployment');
};
export const createCanvas = unavailable;
export const GlobalFonts = { registerFromPath: unavailable };
