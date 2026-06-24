# Releasing

Nunjitsu uses Changesets for versioning, GitHub Releases for immutable release
points, and npm trusted publishing for package publication.

## Prepare a version

Every publishable pull request should add a `.changeset/*.md` file describing
the user-visible change and selecting a `patch`, `minor`, or `major` bump.

When the accumulated changes are ready:

```sh
pnpm version:packages
```

This consumes pending changesets, updates `package.json`, and writes the release
notes to `CHANGELOG.md`. Review and commit those generated changes, then push
them to `main`.

## Automatic release flow

A push to `main` runs `.github/workflows/release.yml`. The workflow examines
every new first-parent commit rather than only the final push state. Whenever a
commit changes `package.json` to a stable version without an existing release,
the workflow:

1. creates `v<version>` at that exact commit;
2. publishes the corresponding GitHub Release with generated notes; and
3. dispatches `.github/workflows/publish.yml` for that tag.

This means a push containing multiple version commits produces one correctly
located release for each version. Force-pushed `main` history is rejected rather
than guessed.

The publish workflow checks out the release tag, confirms that its version
matches `package.json`, runs the full test suite, builds the package, and submits
it to npm staging. A maintainer must inspect and approve the staged version with
npm 2FA before it becomes public.

## Manual releases

Publishing a GitHub Release manually also triggers `publish.yml`. The tag may
point to a specific commit on another branch, provided that:

- the tag is named `v<version>`;
- that commit contains the matching stable `package.json` version; and
- the release is published rather than left as a draft.

Do not move or reuse a release tag after publication. If a version has already
been released or staged from the wrong code, fix the source and prepare a new
package version.

## Trusted publisher configuration

The npm package must configure this trusted publisher:

| Setting | Value |
| --- | --- |
| Owner | `Rugvip` |
| Repository | `nunjitsu` |
| Workflow | `publish.yml` |
| GitHub environment | `npm` |
| Allowed action | `npm stage publish` |

The workflow authenticates through GitHub OIDC and must not use an npm access
token. Repository settings should restrict the `npm` environment to version
tags. npm package settings should require 2FA and disallow token-based
publication after trusted publishing has been verified.

The package remains the public, unscoped `nunjitsu` package, and the repository
URL in `package.json` must remain `https://github.com/Rugvip/nunjitsu.git` for
npm provenance validation.
