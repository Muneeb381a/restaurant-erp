import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import agentScript from '../../assets/print-helper/agent.ps1?raw';
import { base64Lines, installerBatch } from './printHelperInstaller';

const URL_ = 'https://example.vercel.app/api/v1/r/acme';
const KEY = '4c8b1023-4c0a-4257-9e0f-03364da62905.8ATkNSGlq6qQ7RGjUuYbuD6ce-1i3x0_k';

describe('printHelperInstaller', () => {
  it('splits the script into short base64 lines that decode back to the same script', () => {
    const lines = base64Lines(agentScript);
    expect(lines.every((l) => l.length <= 64 && /^[A-Za-z0-9+/=]+$/.test(l))).toBe(true);
    const back = new TextDecoder().decode(
      Uint8Array.from(atob(lines.join('')), (c) => c.charCodeAt(0)),
    );
    expect(back).toBe(agentScript);
  });

  it("is a batch file with this restaurant's address and key, nothing that cmd would misread", () => {
    const bat = installerBatch({ url: URL_, key: KEY });
    expect(bat).toContain(`{"url":"${URL_}","key":"${KEY}"}`);
    expect(bat).toContain('certutil -f -decode');
    expect(bat).toContain('Startup');
    // every line is short, and the data lines contain none of cmd's special characters
    for (const line of bat.split('\r\n')) expect(line.length).toBeLessThan(400);
    const data = bat.split('\r\n').filter((l) => /^echo [A-Za-z0-9+/=]{20,}$/.test(l));
    expect(data.length).toBeGreaterThan(20);
    expect(bat.endsWith('\r\n')).toBe(true);
  });

  it('writes the installer to a file when asked (used to try it on a real Windows computer)', () => {
    const out = process.env.WRITE_INSTALLER;
    if (!out) return;
    writeFileSync(
      out,
      installerBatch({ url: process.env.HELPER_URL ?? URL_, key: process.env.HELPER_KEY ?? KEY }),
    );
  });
});
