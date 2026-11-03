# Images in the app

Everything here is served from `public/` at the site root.

| Path | What it is |
| --- | --- |
| `public/crew/<id>.jpg` | Standing photos of the six crew characters (`boss`, `scout`, `hauler`, `insider`, `fixer`, `negotiator`) with the campaign text removed. Used in the Crew band on Deals. |
| `public/crew/<id>-pose.jpg` | One pose per character, used on the Crew page (`src/proto/CrewScreen.tsx`). |
| `public/crew/<look>.jpg` | A picture made for one spot, such as `scout-map` for page not found. Shown with `<CrewArt look="…" />` from `src/proto/CrewArt.tsx`, whose `CrewLook` type lists every look. |
| `public/crew/crew-group.jpg` | The crew together, on the welcome card. |
| `public/og.jpg` | The 1200x630 picture shown when a Bounty link is shared. It is set in `index.html`. |
| `public/404.html` | The page-not-found page, which shows `scout-map`. |
| `public/products/<sku>.jpg` | AI photos for the made-up sample products. Development only: remove them, and `SAMPLE_PHOTO` in `src/Planner.tsx`, before launch. |
| `public/fonts/` | Cal Sans, the heading font, with its licence. |

## Rules for crew pictures

- Always use a plain white background, and put no text on the picture.
- Show the whole body. Frames use `object-fit: contain` anchored to the bottom, so feet are never cut off. Don't switch them to `cover`.
- Give each spot its own picture rather than reusing one.
- The full-size masters, the generators and a list of which picture goes where are in the shared project files, under `crew/` (see `crew/README.md` there).
