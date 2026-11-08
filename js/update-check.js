// Tells you when GitHub has a newer version than your copy of the app.
//
// serve.py answers /version.json with the commit, branch and GitHub repo of
// the folder it serves. At most once a day this asks GitHub whether that
// branch has commits yours doesn't, and if so shows a notice in the status
// bar: run `git pull` to update. It never changes anything itself.
//
// Nothing is shown when there's nothing to compare: the folder isn't a git
// clone, serve.py isn't running, the app is hosted elsewhere (GitHub Pages
// updates itself), the repo is private, or you're offline. Commits you
// haven't pushed don't count as "behind".

const KEY = 'mockup-studio:update-check';
const DAY = 24 * 60 * 60 * 1000;

const note = document.getElementById('updateNote');
const text = document.getElementById('updateText');

const load = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
};
const store = (v) => {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window */ }
};

async function localVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const v = await res.json();
    return v.commit && v.branch && v.branch !== 'HEAD' && v.repo ? v : null;
  } catch {
    return null; // serve.py isn't running
  }
}

/** How many commits the GitHub branch has that `commit` doesn't (0 if none). */
async function compare({ repo, branch, commit }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/compare/${commit}...${encodeURIComponent(branch)}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  // 404: a private repo, or your commit / branch isn't on GitHub.
  if (!res.ok) return { behind: 0 };
  return { behind: (await res.json()).ahead_by || 0 };
}

// Dismissing hides the notice until GitHub has more commits, or you pull.
const dismissKey = (v, result) => `${v.commit}:${result.behind}`;

function show(v, result) {
  const n = result.behind;
  text.innerHTML = `Update on GitHub (${n} new commit${n === 1 ? '' : 's'}): run <code>git pull</code> in the app’s folder, then reload`;
  note.title = `See what's new on github.com/${v.repo}`;
  note.querySelector('a').href = `https://github.com/${v.repo}/compare/${v.commit.slice(0, 12)}...${encodeURIComponent(v.branch)}`;
  note.hidden = false;
  note.querySelector('button').onclick = () => {
    note.hidden = true;
    store({ ...load(), dismissed: dismissKey(v, result) });
  };
}

async function check() {
  const v = await localVersion();
  if (!v) return;
  const saved = load();
  let result = saved.result;
  if (saved.commit !== v.commit || saved.branch !== v.branch || !result || Date.now() - saved.at > DAY) {
    try {
      result = await compare(v);
    } catch {
      return; // offline, or GitHub unreachable
    }
    store({ ...saved, commit: v.commit, branch: v.branch, at: Date.now(), result });
  }
  if (result.behind > 0 && dismissKey(v, result) !== load().dismissed) show(v, result);
}

if (note && navigator.onLine !== false) check();
