# Link Preview (Open Graph) Image — diversity-roofing.com

The old preview was a stock photo of an office building with "DIVERSITY ROOFING"
pasted on a billboard. Replaced with a real brand card: the actual logo on an
architectural-shingle background, service area, and phone number.

**Ship file:** `og-diversity-roofing.jpg` — 1200×630, ~77 KB, JPEG q88.

JPEG rather than PNG on purpose. The shingle texture has a lot of fine granule
noise, which PNG cannot compress (656 KB vs 77 KB for the same image). Link
previews are fetched by crawlers on cold connections; the smaller file wins.

---

## Installing it

Upload the image somewhere on your own domain — `https://www.diversity-roofing.com/og-diversity-roofing.jpg`
— then add these tags to the `<head>` of **every** page:

```html
<meta property="og:title"       content="Diversity Roofing — Jacksonville, FL" />
<meta property="og:description" content="Storm damage inspection and insurance claim assistance across Jacksonville, Orange Park, Middleburg, and St. Augustine. We fight for your home so you don't have to." />
<meta property="og:image"       content="https://www.diversity-roofing.com/og-diversity-roofing.jpg" />
<meta property="og:image:width"  content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url"         content="https://www.diversity-roofing.com/" />
<meta property="og:type"        content="website" />

<meta name="twitter:card"  content="summary_large_image" />
<meta name="twitter:image" content="https://www.diversity-roofing.com/og-diversity-roofing.jpg" />
```

Four things that trip people up:

1. **`og:image` must be an absolute URL.** A relative path (`/og.jpg`) is
   silently ignored by every crawler.
2. **`twitter:card` must be `summary_large_image`.** Without it you get the
   small square thumbnail instead of the wide banner.
3. **Per-page titles.** Keep one shared `og:image`, but give each page its own
   `og:title` and `og:description`, or every link looks identical.
4. **Caches are sticky.** iMessage, Facebook, and LinkedIn cache previews for
   days. After deploying, force a refresh (below) or you will keep seeing the
   old office-building image and think it did not work.

## Forcing a cache refresh

| Platform | How |
|---|---|
| Facebook / Instagram | [Sharing Debugger](https://developers.facebook.com/tools/debug/) → paste URL → **Scrape Again** |
| LinkedIn | [Post Inspector](https://www.linkedin.com/post-inspector/) |
| X / Twitter | [Card Validator](https://cards-dev.twitter.com/validator) |
| iMessage | Hardest to clear. Try appending `?v=2` to the URL to test, and give it ~24h. |

---

## Regenerating the image

```bash
cd assets
npm install playwright --no-save
node render.js
```

Outputs `og-diversity-roofing.png`. Convert to the ship JPEG with:

```bash
python3 -c "
from PIL import Image
Image.open('og-diversity-roofing.png').convert('RGB').save(
    'og-diversity-roofing.jpg','JPEG',quality=88,optimize=True,progressive=True)"
```

`og-card.html` expects `logo-color-roofing.png` beside it — that is the
**"NoBg Color Roofing Logo.png"** file from the Drive `Logo Files` folder.
Despite the name it is the *white* logo on transparency, which is why it works
on the dark roof. Do not swap in the black version.

### Brand values used

Sampled directly from the logo file, not guessed:

| Token | Value | Use |
|---|---|---|
| Logo white | `#ffffff` | Mark and wordmark |
| Accent steel blue | `#b5c4db` | Tagline, divider, bottom bar |
| Roof base | `hsl(205–223, 10–19%, 16–27%)` | Shingle tabs, varied per tab |

### Editing the card

Everything is in `og-card.html`:

- `COURSE_H` / `TAB_W` — shingle scale
- `.logo { width }` — logo size
- `.meta` — the service-area and phone line
- The `rnd()` seed is fixed, so renders are reproducible. Change the seed for a
  different shingle pattern.

One structural note: `#roof` sets `isolation: isolate` deliberately. Each
shingle course carries its own `z-index`, and without that containment the
lower courses paint over the logo and phone number.
