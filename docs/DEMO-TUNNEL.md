# Showing the app over the internet (demo only)

`pnpm tunnel` opens a free Cloudflare quick tunnel to the app running on this computer, so a client or a phone
anywhere can open it. It is for demos, not for a restaurant's real use (printers and the cash drawer live on the
restaurant's network, and a laptop is not a server).

1. Install once: `winget install --id Cloudflare.cloudflared` (Windows) or `brew install cloudflared` (macOS).
2. Start the app: `pnpm dev`.
3. In another terminal: `pnpm tunnel`. It prints `https://<random>.trycloudflare.com`.
4. Open that address. Press Ctrl+C to close it.

Good to know
- The address changes every run and exists only while the command runs.
- Quick tunnels do not carry Server-Sent Events (to our knowledge), so the live "changes appear at once" feed falls
  back to the screen refreshing every few seconds.
- Anyone with the link can reach the sign-in screen: change the dev PINs, use demo data only, close the tunnel after.
- To let guests scan the QR menu through it, set Admin -> QR menu -> Address to the tunnel address; print the QR
  again when the address changes.
- A stable address needs a named tunnel (free Cloudflare account and your own domain).
