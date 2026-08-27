# Screenshot tooling

Regenerates every product screenshot used by the in-app help centre and the landing page.
The set is scripted rather than hand-captured so it can be rebuilt in one command after a UI
change — which matters, because stale screenshots are worse than none.

## Usage

```bash
cd tools
npm install                      # once (playwright + sharp)
npx playwright install chromium  # once
node capture-screenshots.mjs     # all shots, EN + FR
node capture-screenshots.mjs 08 kiosk   # only ids containing "08" or "kiosk"
```

Output → `../assets/screenshots/<id>-<lang>.webp`

Review the whole run at a glance:

```bash
node contact-sheet.mjs en    # writes tools/sheet-en.png (gitignored)
node contact-sheet.mjs fr
```

## How it works

- Starts a throwaway static server on a random port and drives the real `index.html`, so the
  images are always of the shipping UI — never a mock.
- Runs in **demo mode** (`startDemo()`), which seeds a realistic Québec café. Two consequences
  worth keeping: the shots show a busy shop rather than empty tables, and no real customer data
  can ever leak into a published asset.
- Captures at `deviceScaleFactor: 2` for crisp text, then encodes WebP q82 — these are flat
  colour UI shots, so WebP holds up visually at roughly a third of the PNG weight. Several of
  them land on the landing page, so the weight matters.
- Callouts (rings / numbered chips / curved arrows) are injected as real DOM + SVG by
  `annotate.mjs` and captured in the frame. Drawing them from live element boxes — instead of
  painting on the PNG afterwards — means they stay vector-crisp and land on the right control
  even when the layout shifts.
- Help shots are cropped to the region carrying the instruction (`__ann.bounds()`), at full
  width so the set stays visually consistent. Add `context: ['.selector']` to a shot to keep
  surrounding chrome in frame when a tight crop would leave the screen unrecognisable.

## Adding or changing a shot

Edit the `SHOTS` array in `capture-screenshots.mjs`. Each entry is:

```js
{
  id: '12-thing',              // becomes 12-thing-en.webp / 12-thing-fr.webp
  kind: 'help',                // 'help' = annotated + cropped, 'landing' = clean full frame
  page: 'sites',               // argument to the app's own navigate()
  context: ['.punch-card'],    // optional: extra selectors to keep in the crop
  before: async p => { ... },  // optional: open a modal, generate a report, etc.
  title: T('English', 'Français'),   // article heading — NOT burned into the image
  annotate: [
    { fn:'ring',  sel:'#thing' },
    { fn:'badge', sel:'#thing', n:'1', corner:'left' },   // 'left'/'right' sit outside the box
    { fn:'arrow', sel:'#thing', side:'auto', text: T('Do this', 'Faites ceci') },
  ],
}
```

Step titles deliberately live in the shot spec and get rendered by the help article markup
rather than baked into the pixels — so copy can be fixed or retranslated without re-capturing,
and text never collides with the UI beneath it.

`before` hooks run against the live app, so they can call its own functions. Two traps worth
knowing: pick a clocked-**out** employee before opening the PIN pad (otherwise the app shows
the "already clocked in" warning instead), and call `generateReport()` before shooting Reports
(the results table is empty until then).
