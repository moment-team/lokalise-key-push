const fetch = require('node-fetch').default;

module.exports = function gitlabVcs({ token, jobToken, projectId, apiBase = 'https://gitlab.com/api/v4' }) {
  const base = apiBase.replace(/\/$/, '');

  function authHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Private-Token'] = token;
    else if (jobToken) headers['Job-Token'] = jobToken;
    return headers;
  }

  async function httpGet(url, extraHeaders = {}) {
    const res = await fetch(url, { headers: { ...authHeaders(), ...extraHeaders } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitLab GET ${url} failed: ${res.status} ${res.statusText} ${text}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  return {
    // Return a normalized compare result: { commits: [{ id, sha, parents:[{sha}], committedAt }] }
    compare: async (baseRef, headRef) => {
      const url = `${base}/projects/${projectId}/repository/compare?from=${encodeURIComponent(baseRef)}&to=${encodeURIComponent(headRef)}`;
      const res = await httpGet(url);
      const data = await res.json();
      const commits = (data.commits || []).map(c => ({
        id: c.id,
        sha: c.id,
        parents: (c.parent_ids || []).map(sha => ({ sha })),
        committedAt: c.committed_date
      }));
      return { commits };
    },

    // Return { files: [{ filename }], parents:[{sha}], committedAt }
    getCommit: async (sha) => {
      const metaUrl = `${base}/projects/${projectId}/repository/commits/${encodeURIComponent(sha)}`;
      const diffUrl = `${metaUrl}/diff`;
      const [metaRes, diffRes] = await Promise.all([httpGet(metaUrl), httpGet(diffUrl)]);
      const meta = await metaRes.json();
      const diffs = await diffRes.json();
      const filenames = new Set();
      (diffs || []).forEach(d => {
        if (d.new_path) filenames.add(d.new_path);
        if (d.old_path) filenames.add(d.old_path);
      });
      return {
        files: Array.from(filenames).map(f => ({ filename: f })),
        parents: (meta.parent_ids || []).map(p => ({ sha: p })),
        committedAt: meta.committed_date
      };
    },

    // Return raw file content as string at a given ref
    getFileContent: async (filePath, ref) => {
      const url = `${base}/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
      const res = await httpGet(url, { Accept: 'text/plain' });
      return await res.text();
    }
  };
}
