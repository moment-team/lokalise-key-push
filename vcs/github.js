const { Octokit } = require('octokit');

module.exports = function githubVcs({ token, repository }) {
  const octokit = new Octokit({ auth: token });
  const baseUrl = `/repos/${repository}`;

  return {
    // Return a normalized compare result: { commits: [{ id, sha, parents:[{sha}], committedAt }]} matching the order from base->head
    compare: async (base, head) => {
      const { data } = await octokit.request(baseUrl + '/compare/{base}...{head}', {
        base,
        head
      });
      // GitHub returns commits ascending from base to head already
      const commits = (data.commits || []).map(c => ({
        id: c.sha,
        sha: c.sha,
        parents: (c.parents || []).map(p => ({ sha: p.sha })),
        committedAt: c.commit && c.commit.committer && c.commit.committer.date
      }));
      return { commits };
    },

    // Return { files: [{ filename }] , parents:[{sha}], committedAt }
    getCommit: async (sha) => {
      const { data } = await octokit.request(baseUrl + '/commits/{sha}', { sha });
      const files = (data.files || []).map(f => ({ filename: f.filename }));
      return {
        files,
        parents: (data.parents || []).map(p => ({ sha: p.sha })),
        committedAt: data.commit && data.commit.committer && data.commit.committer.date
      };
    },

    // Return raw file content as string at a given ref
    getFileContent: async (path, ref) => {
      const { data } = await octokit.request(baseUrl + '/contents/{path}?ref={ref}', {
        path,
        ref,
        headers: { accept: 'application/vnd.github.VERSION.raw' }
      });
      return data;
    }
  };
}
