# Discord Activity artwork

Upload these files in the Discord Developer Portal under **Activities → Art Assets**.

| Portal slot | File | Dimensions | Format |
| --- | --- | --- | --- |
| Background | `words-and-wizards-grid-background.png` | 1024×576 | PNG |
| Cover Art | `words-and-wizards-cover-art.png` | 1024×576 | PNG |
| App Icon | `words-and-wizards-app-icon.png` | 1024×1024 | PNG |

All files are under Discord's 10 MB limit.

## Generation notes

The assets were generated with the built-in image-generation workflow using `src/assets/wizard_background.png` and `src/assets/logo.png` as visual references, then resized with high-quality bicubic sampling to the exact portal dimensions.

### Grid background prompt

> Recompose the referenced Words & Wizards forest scene as a polished 16:9 Discord Activity Grid-view background. Preserve the friendly hand-painted cartoon style, recognizable blue elderly wizard, purple young wizard, turquoise forest palette, rounded shapes, and restrained golden magic. Cluster detailed artwork at the outer edges, with both wizards low and partially cropped at the far left and right. Keep trees, mushrooms, clouds, and foliage near the perimeter. Leave the central 55 percent genuinely open, calm, low contrast, and uncluttered for Discord UI. No text, title, logo, border, UI, or watermark.

### Cover art prompt

> Create polished 16:9 Discord Activity Shelf cover art for Words & Wizards using the referenced forest scene and exact logo identity. Place the recognizable blue elderly wizard on the left and cheerful purple young wizard on the right, casting toward the center. Put the exact title “WORDS & WIZARDS” prominently in the central safe area using chunky dimensional golden lettering, dark navy outline, open spellbook, wand, and spark motifs. Use strong thumbnail-readable contrast, generous safe margins, and joyful magical party-game energy. No subtitle, Discord branding, extra words, UI, border, or watermark.

### App icon prompt

> Create a distinctive simplified square Discord app icon based on the existing logo. Use one bold open cyan-blue spellbook with a dark navy outline and one diagonal wooden wand creating a bright golden starburst. Center the compact emblem within the middle 72 percent on a full-bleed deep navy-to-teal magical background. Keep it recognizable at 32 px with a clean silhouette and strong contrast. No words, letters, title, characters, UI, border, baked rounded corners, or watermark.
