# Third-party material shipped with Coffer

Coffer's own code is licensed under the AGPL (see [`LICENSE`](./LICENSE)). This file lists
material written by others that ships **inside the installed app** under a different
licence. Development dependencies that never reach an installer are not listed here; the
runtime npm dependencies carry their own licence files in `node_modules`.

## IBM Plex typefaces

|           |                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Author    | IBM Corp.                                                                                                                    |
| Licence   | SIL Open Font License 1.1, with Reserved Font Name "Plex"                                                                    |
| Text      | [`src/renderer/src/assets/fonts/OFL.txt`](./src/renderer/src/assets/fonts/OFL.txt), copied unchanged from the packages below |
| Source    | IBM's own npm packages, published from [github.com/IBM/plex](https://github.com/IBM/plex)                                    |
| Where     | `src/renderer/src/assets/fonts/`, declared in `src/renderer/src/styles/base.css`                                             |
| Modified? | No. The files are the packages' `fonts/complete/woff2/` files, byte for byte                                                 |

The OFL allows the fonts to be bundled, embedded and redistributed with software under any
licence, provided the licence travels with them and the fonts are not sold on their own.
The installed app carries this file and `licenses/ibm-plex/OFL.txt` beside its executable
for that reason (see `extraFiles` in `electron-builder.yml`).

| Package                     | Version | File                                   | SHA-256                                                            |
| --------------------------- | ------- | -------------------------------------- | ------------------------------------------------------------------ |
| `@ibm/plex-sans`            | 1.1.0   | `IBMPlexSans-Regular.woff2`            | `ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a` |
|                             |         | `IBMPlexSans-Medium.woff2`             | `5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d` |
|                             |         | `IBMPlexSans-SemiBold.woff2`           | `f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205` |
|                             |         | `IBMPlexSans-Bold.woff2`               | `fa7130d854a660b39a7fc9e6e0f2dc23dba5f1346e2adea3e1fe37b6d884133d` |
| `@ibm/plex-serif`           | 2.0.0   | `IBMPlexSerif-SemiBold.woff2`          | `030d808e82f99ebe5c21d50745bd06e5ce16ad9e94b360f5adcc19362beb5344` |
| `@ibm/plex-mono`            | 2.5.0   | `IBMPlexMono-Regular.woff2`            | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
|                             |         | `IBMPlexMono-Medium.woff2`             | `33faf307fa6031fb4062276d7320a6d632de890cbb347576fd80cfa01077bc25` |
| `@ibm/plex-sans-devanagari` | 1.1.0   | `IBMPlexSansDevanagari-Regular.woff2`  | `9414954cbb343be6c8fa97b716a93eb7cd5501043356cdbb704e233db5f8ca85` |
|                             |         | `IBMPlexSansDevanagari-Medium.woff2`   | `2b39f69997b1de44cfef6f6f6ef899a4f434a84af1dbc21886558e0f4d8d29b9` |
|                             |         | `IBMPlexSansDevanagari-SemiBold.woff2` | `adbd61f32837a5b83b51f5a201305e4163f73505bf02262b3d30965fa96f948a` |
|                             |         | `IBMPlexSansDevanagari-Bold.woff2`     | `514fe29e79c3dfc0aad4bfb12ede03975acfc26349c9250eee7f77b126e5c3c0` |

To update a face: `npm pack @ibm/<package>@<version>` outside the repo, copy the file from
`package/fonts/complete/woff2/`, and change its row here. The fonts are vendored rather than
installed as a dependency so that nothing about them can change on an `npm install`.
