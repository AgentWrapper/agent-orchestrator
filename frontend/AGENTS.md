# Agent Guide: Frontend

This directory contains the Pune Reads Post Studio frontend. It is a static, single-file app: `index.html` contains the markup, styles, and browser JavaScript. There is no package manager, build step, bundler, framework, or test runner in this directory.

## Scope

- Frontend root: `saturday-reads/`
- Main file: `index.html`
- User docs: `README.md`
- Backend API directory: `../saturday-reads-api/`

Do not edit backend functions from this directory unless the task explicitly spans both apps.

## Runtime Model

The page is intended for GitHub Pages or direct static hosting. Browser code calls the deployed backend configured by:

```js
const PROXY_URL = "https://pune-reads-api.vercel.app";
```

If you change API routes, request bodies, auth headers, or response shapes, update the backend in `../saturday-reads-api/api/` and the backend agent guide as part of the same task.

## Important Frontend Flows

- Password gate:
  - `submitPassword()` posts to `/api/verify-password`.
  - The password is stored in `sessionStorage` as `pune_reads_site_password`.
  - The user name is stored as `pune_reads_user_name`.
  - Authenticated API requests send `x-site-password`.
- Photo selection:
  - `addPhotos(files)` stores `{ file, url }` entries in the `photos` array.
  - `rmPhoto(idx, el)` leaves null slots to preserve thumbnail index stability.
  - Up to 10 photos can be selected.
- Caption generation:
  - `run()` validates input, converts up to 5 images to base64 with `toBase64()`, then calls `generateCaption()`.
  - `generateCaption()` posts `{ images, context }` to `/api/generate-caption`.
- Publishing:
  - `postToIG()` uploads each selected file to Cloudinary through `uploadToCloudinary()`, then calls `publishToInstagram()`.
  - `uploadToCloudinary()` first calls `/api/cloudinary-sign`, then uploads directly to Cloudinary from the browser.
  - `publishToInstagram()` posts `{ imageUrls, caption }` to `/api/publish-to-instagram`.

## Editing Guidelines

- Keep the app dependency-free unless the user explicitly asks for a larger frontend refactor.
- Keep CSS, markup, and JS in `index.html`; the README documents this as the current architecture.
- Preserve the backend contract:
  - `Content-Type: application/json` for backend API requests.
  - `x-site-password` on protected backend API calls.
  - raw base64 strings for `images`, without the `data:image/...;base64,` prefix.
- Do not move secrets into the frontend. API keys, Cloudinary secret, Instagram token, and site password live only in backend environment variables.
- When adding UI controls, update both the DOM and the relevant state/helper functions. This app does not use a rendering framework.
- Be careful with `contenteditable`; publishing reads plain text via `.textContent.trim()`.
- Keep user-facing copy concise and operational. This is a posting tool, not a marketing page.

## Local Verification

Open the file directly in a browser for layout-only checks:

```bash
open index.html
```

For end-to-end checks, run the backend locally or use the deployed backend, then set `PROXY_URL` accordingly. Browser CORS must match the backend `ALLOWED_ORIGIN` setting.

Manual smoke test:

1. Load the page.
2. Enter the site password and a name.
3. Add one or more images.
4. Add a date and at least one book.
5. Generate a caption.
6. Edit or copy the caption.
7. Publish only when using valid Cloudinary and Instagram credentials.

## Common Tasks

- Change deployed backend URL: edit `PROXY_URL`.
- Add a new backend call: create a helper near the existing API helper functions and include `x-site-password` if the endpoint is protected.
- Change the caption form: update the form markup, `getBooks()` or related field readers, and the request body in `generateCaption()`.
- Change publishing behavior: update `postToIG()` and coordinate any backend changes in `api/publish-to-instagram.js`.
- Change auth behavior: update `submitPassword()`, `getPassword()`, `handle401()`, and `api/verify-password.js` together.

## Deployment Notes

This frontend can be hosted by GitHub Pages because it is static. After changing API behavior, deploy the backend first, then update `PROXY_URL` if the backend URL changed.
