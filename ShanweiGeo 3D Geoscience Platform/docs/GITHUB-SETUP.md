# Pushing to GitHub

The repository is initialised and committed locally on the `main` branch. This
document covers creating the remote repository and completing the first push.

> **Note.** The commands below use `YOUR_PATH` and `YOUR_USERNAME` as
> placeholders. Replace them with the local path of your checkout and your own
> GitHub username before running anything.

---

## Before you start

You need:

- A GitHub account
- Either the [GitHub CLI](https://cli.github.com/) or a personal access token
- Your GitHub username or numeric user ID

### Set your commit identity

Replace the placeholder email with your real GitHub privacy address before
pushing, so commits are attributed to your account:

```bash
git config user.email "YOUR_GITHUB_ID+YOUR_USERNAME@users.noreply.github.com"
```

You can find the numeric ID in your GitHub profile URL
(`https://github.com/users/YOUR_USERNAME` shows the ID) or under
**Settings → Emails**.

`git config user.name` is already set to `Rao Yingchun`. Both settings are
**repository-local** — your other projects are unaffected.

---

## Option A — GitHub CLI (recommended)

```bash
winget install --id GitHub.cli        # if not installed
gh auth login                         # sign in
```

Then create the repository and push in one step:

```bash
cd "YOUR_PATH/ShanweiGeo 3D Geoscience Platform"
gh repo create ShanweiGeo-3D-Geoscience-Platform --source=. --remote=origin --push
```

Add `--private` if you want the repository to stay private; omit it for a
public repository.

## Option B — Web interface + git

1. Go to <https://github.com/new>
2. Repository name: `ShanweiGeo-3D-Geoscience-Platform`
3. Visibility: **Public** or **Private**, depending on your intent
4. **Do not** tick "Add a README file", `.gitignore` or a licence — the
   repository already has all three.
5. Create the repository.
6. Back in the project:

```bash
cd "YOUR_PATH/shanweiGeo-3D-Geoscience-Platform"
git remote add origin https://github.com/YOUR_USERNAME/ShanweiGeo-3D-Geoscience-Platform.git
git push -u origin main
```

Git will prompt for your username and a personal access token. If you do not
have one, create it at
<https://github.com/settings/tokens> with the `repo` scope.

---

## What gets pushed

| | Size | Mechanism |
| --- | --- | --- |
| Source, backend, packaging config | ~6 MB | ordinary git blobs |
| Poly Haven runtime textures | ~144 MB | ordinary git blobs |
| Scanned geological figures | ~440 MB | **Git LFS** |
| `素材库/` reference imagery | ~52 MB | excluded, not pushed |
| Dependencies, build output, Python runtime | ~1 GB | excluded, not pushed |

> **Note on directory names.** `素材库/` (reference library) keeps its original
> Chinese name because it is a real path on disk. The application does not read
> it at runtime, but the path is preserved so the directory keeps its identity
> across clones.

The LFS objects upload first, then the git history follows. Expect the first
push to take a while on a slow connection — 440 MB over LFS plus ~150 MB of
regular blobs.

### Verifying LFS after the push

```bash
git lfs ls-files        # should list 26 figure files
git lfs status          # should report nothing pending
```

If the push reports LFS errors, check that the account has LFS bandwidth
available; GitHub's free tier includes 10 GB of LFS storage and bandwidth per
month, which comfortably covers this repository.

---

## After the first push

### Add a release

The distributable ZIP is ~265 MB, which exceeds GitHub's 100 MB per-file
limit for regular uploads but is fine as a **release asset**:

```bash
npm run build:english
gh release create v1.0.0 dist-release/ShanweiGeo-3D-Geoscience-Platform-Windows-x64.zip \
  --title "ShanweiGeo 3D Geoscience Platform v1.0.0" \
  --notes "Initial release."
```

### Collaborators

For a private repository, add people under **Settings → Collaborators**, then
they clone with:

```bash
git clone https://github.com/YOUR_USERNAME/ShanweiGeo-3D-Geoscience-Platform.git
git lfs pull        # if the LFS objects were not fetched automatically
```

---

## Local housekeeping

Build output directories are not needed for development and can be removed to
reclaim space. They are all regenerable.

```bash
# the current packaged build (keep the ZIP if you need to share it)
rm -rf "ShanweiGeo 3D Geoscience Platform/dist-release/win-unpacked"
```

`node_modules/` is required for `npm start` and can be restored with
`npm install`. `runtime/` and `backend/vendor/` are release artifacts — the
embedded Python runtime and the offline NumPy/PyProj wheels.

---

## Troubleshooting

**`git push` fails with "Authentication failed"**
Use a personal access token as the password, not your account password. Or
install the CLI and use `gh auth login`.

**`git push` fails with "large files detected"**
Something outside the ignore rules slipped in. Find it with:

```bash
git ls-files | while read f; do
  size=$(stat -c%s "$f" 2>/dev/null || echo 0)
  [ "$size" -gt 50000000 ] && echo "$((size/1048576))MB $f"
done
```

**LFS objects are missing after cloning**
Run `git lfs pull` inside the repository.

**`npm start` fails after cloning**
Run `npm install` — the Electron runtime is not tracked. The packaged build
(`npm run build:english`) also needs the embedded Python runtime under
`runtime/python/`, which is likewise not tracked.
