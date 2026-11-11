import { describe, expect, it } from 'vitest';
import { whatsappDigits, whatsappLink } from './whatsapp';

describe('whatsapp link', () => {
  it('turns local and international spellings of a number into the form WhatsApp wants', () => {
    expect(whatsappDigits('0300 1234567')).toBe('923001234567');
    expect(whatsappDigits('+92 300-1234567')).toBe('923001234567');
    expect(whatsappDigits('00923001234567')).toBe('923001234567');
    expect(whatsappDigits('923001234567')).toBe('923001234567');
  });
  it('encodes the message so line breaks, stars and symbols survive', () => {
    const url = whatsappLink('03001234567', '*Sales* Rs 1,000\nNet & more');
    expect(url).toBe('https://wa.me/923001234567?text=*Sales*%20Rs%201%2C000%0ANet%20%26%20more');
  });
  it('works without a number: WhatsApp then asks who to send it to', () => {
    expect(whatsappLink('', 'hi')).toBe('https://wa.me/?text=hi');
    expect(whatsappLink(null, 'hi')).toBe('https://wa.me/?text=hi');
  });
});
