# Releasing

## Package identity

Nunjitsu is the public, unscoped `nunjitsu` package on the npm registry. Its
canonical source repository is
[`Rugvip/nunjitsu`](https://github.com/Rugvip/nunjitsu), and `package.json`
must retain the matching repository URL because npm validates it during trusted
publishing.

The only supported automated publisher is the GitHub-hosted workflow at
`.github/workflows/publish.yml`. It authenticates to npm through GitHub's OIDC
identity and must not use an npm access token.

## Registry trust configuration

The npm trusted-publisher settings must name:

- GitHub owner `Rugvip`;
- repository `nunjitsu`;
- workflow filename `publish.yml`;
- environment name `npm`; and
- allowed action `npm stage publish` only.

No npm access token belongs in GitHub or the repository. After verifying the
OIDC workflow, npm package settings should require 2FA and disallow token-based
publication.

## Versioning and changelog

Changesets is the versioning source of truth. Each publishable pull request adds
a reviewable `.changeset/*.md` file that names `nunjitsu`, selects `patch`,
`minor`, or `major`, and contains the eventual changelog text. Maintainers may
run `pnpm changeset` to create one interactively; coding agents follow
`AGENTS.md` and edit these small files directly.

When preparing a release, `pnpm version:packages` consumes all pending
changesets, applies the combined semantic version bump, and updates
`CHANGELOG.md`. Commit those generated changes before creating the matching
`v<version>` tag and GitHub Release. Version preparation does not publish or
create a GitHub Release by itself.

## Release lifecycle

Publishing a GitHub Release triggers `publish.yml` at the release tag. The job
must reject a release whose `v<version>` tag does not exactly match the stable
version in `package.json`. Prerelease versions remain unsupported until the
versioning policy defines their npm distribution tags.

The job installs from `pnpm-lock.yaml`, runs the complete repository test
command on Node.js 24, builds the package, and submits it with
`npm stage publish`. npm CLI 11.15 or newer and Node.js 22.14 or newer are
required for staged trusted publishing. The workflow uses a GitHub-hosted
runner with `id-token: write`, no npm token, and the exact trusted-publisher
identity configured above.

The publish job uses the GitHub environment named `npm`, making the environment
part of its OIDC identity. Repository settings should restrict that environment
to version tags. A required GitHub reviewer is optional because npm approval
with 2FA remains mandatory before a staged version becomes public.

A staged version is not public. A maintainer must inspect and approve it with
npm 2FA before it becomes available. Trusted publishing automatically attaches
provenance when the GitHub repository and npm package are public.
