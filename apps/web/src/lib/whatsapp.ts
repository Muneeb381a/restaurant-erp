/**
 * A link that opens WhatsApp with the message already typed. With the owner's number set it opens their
 * chat; without one WhatsApp asks who to send it to. Nothing is sent from the till itself: the person
 * taps Send, so it needs no account, key or server connection.
 */
export function whatsappDigits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('00')) return d.slice(2); // 0092300… -> 92300…
  if (d.startsWith('0') && d.length === 11) return `92${d.slice(1)}`; // Pakistani mobile 03xx… -> 923xx…
  return d;
}

export function whatsappLink(phone: string | null | undefined, text: string): string {
  const to = phone ? whatsappDigits(phone) : '';
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
