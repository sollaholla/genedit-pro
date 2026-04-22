# GenEdit Pro

GenEdit Pro is a browser-first AI video editor. Phase 1 (this milestone) ships the editor harness — import, multi-track timeline, preview, and MP4 export — entirely in the browser. Future phases add generative video models, ElevenLabs voice/SFX, and Suno music.

## Stack

- Vite 5 + React 18 + TypeScript
- Tailwind CSS for styling
- Zustand for state
- IndexedDB (`idb`) for media blobs, `localStorage` for project JSON
- `@ffmpeg/ffmpeg` 0.12 for in-browser MP4 export
- `lucide-react` for icons, `nanoid` for IDs

## Phase 1 features

- Import video, audio, and image files via picker or drag-drop. Files are stored locally in IndexedDB; thumbnails and metadata are extracted on import.
- Multi-track timeline (default V1/V2 + A1/A2). Add, remove, hide/mute tracks.
- Drag clips to position, drag edges to trim, split at the playhead (`S`), delete (`Backspace`/`Delete`). Snapping to clip edges and the playhead.
- Preview player driven by a single RAF loop: top-most visible video clip and top-most non-muted audio clip win.
  - Keyboard: `Space` play/pause, `Home`/`End` jump, `,`/`.` step ±1 frame.
- Export to MP4 (H.264/AAC, 1920×1080@30fps) via `@ffmpeg/ffmpeg`. Progress dialog with downloadable result.
- Auto-save: project JSON persists to `localStorage` (debounced).

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check + production build
npm run preview      # preview production build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
```

The dev/preview servers send `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers to keep the door open for the multi-threaded FFmpeg core (currently we use the single-thread core).

## What's intentionally not built yet

- Multi-layer compositing (Phase 1 picks the top-most clip per kind; the engine returns a structure ready for canvas blending in Phase 2).
- Transitions, effects, color, text — Phase 2.
- Backend / AI provider integrations (ElevenLabs, Suno, generative video) — Phase 2 will add a thin server for API keys.
- Undo/redo — operations are pure functions, so a history stack is straightforward to add later.
- Automated tests — UI surface is too volatile this early; Playwright will be added once flows stabilize.
