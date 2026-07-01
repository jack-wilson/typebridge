# TypeBridge

Turn your Figma text styles into a production-ready fluid CSS type scale in one click.

Paste a Figma file URL and a personal access token → TypeBridge extracts your text styles (or infers them from inline text), auto-pairs them into fluid scales by family + weight, and generates copy-pasteable `clamp()` CSS, Tailwind config, and role-based utility classes. A live preview shows specimens and real layout compositions responding to a viewport slider.

## Features

- **Extract from Figma** — reads either published text styles or auto-classifies inline text
- **Auto-pair fluid scales** — groups styles by family + weight and generates a `clamp()` per scale
- **Manual pairing** — click two or more fixed styles to merge them into a fluid pair (alt-click to select all matching family/weight)
- **Reference viewport locking** — extrapolate sizes to a new range and commit them as the new baseline
- **Live preview** — drag the viewport slider to see specimens and layouts (Hero, Card Grid) respond
- **Layout Showcase** — sample compositions using semantic role classes so you see the scale in context
- **Multiple outputs** — CSS custom properties, utility classes, Tailwind `theme.extend.fontSize`, fluid grid utilities

## Try it live

Live at [typebridge.app](https://typebridge.app) (once deployed).

## Local development

TypeBridge is plain HTML/CSS/JS with zero build step.

```bash
git clone https://github.com/YOUR-USERNAME/typebridge.git
cd typebridge
npx serve .
```

Open `http://localhost:3000`.

## How it works

1. **Paste a Figma URL + personal access token** ([how to get one](https://help.figma.com/hc/en-us/articles/8085703771159))
2. TypeBridge fetches your text styles via the Figma REST API
3. Styles are auto-paired into fluid scales (largest → mobile-anchored to smallest → desktop-anchored)
4. Adjust the viewport range and base font size
5. Copy the generated CSS

The token is stored in `sessionStorage` only — it's cleared when you close the tab and is never sent anywhere except `api.figma.com`.

## Architecture

- `index.html` — DOM structure and layout showcase markup
- `app.js` — Figma API client, pair logic, role mapping, CSS generators, DOM rendering
- `styles.css` — Design system (dark mode inspired by shadcn/ui) and responsive rules
- `_headers` — Cloudflare Pages security headers (CSP, HSTS, referrer, etc.)

## Security

- Client-side only — no backend, no token storage on any server
- Strict CSP restricts network requests to `api.figma.com`
- Figma-sourced strings are inserted via `textContent` / `setAttribute`, never `innerHTML`
- Font family values are serialized with `JSON.stringify` before use in generated CSS

## Contributing

Issues and PRs welcome. Please:

1. Open an issue first for larger changes
2. Keep the zero-build constraint (no bundlers, no compile step)
3. Test at both mobile (375px) and desktop (1280px) viewports

## License

MIT — see [LICENSE](./LICENSE).
