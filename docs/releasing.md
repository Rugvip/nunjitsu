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
`CHANGELOG.md`. Commit those generated changes and push them to `main`.
Version preparation does not publish or create a GitHub Release locally.

## Release lifecycle

Every push to `main` triggers `release.yml`. It walks every newly introduced
first-parent commit in order and compares the `package.json` version with that
commit's first parent. For each stable version change without an existing
GitHub Release, it creates `v<version>` at the exact commit containing the
change. A push containing multiple version commits therefore creates each tag
at its corresponding commit rather than tagging only the push head. Automatic
releases require fast-forward `main` history; the workflow rejects a force push
instead of inferring release commits from rewritten history.

The release workflow explicitly dispatches `publish.yml` because GitHub does
not start another workflow from a Release created with `GITHUB_TOKEN`. It first
checks for an existing publish run at the release commit so rerunning release
discovery does not enqueue duplicate publishing. Manually publishing a GitHub
Release continues to trigger `publish.yml` directly.

The publish job checks out the exact release tag and must reject a release
whose `v<version>` tag does not exactly match the stable version in
`package.json`. It also verifies that the tag has a published, non-draft GitHub
Release. Prerelease versions remain unsupported until the versioning policy
defines their npm distribution tags.

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
