import { describe, expect, it } from 'vitest'
import {
  GLAB_HOSTS, NO_FORGE, absoluteUrl, apiProject, chooseForge, encodePath, forgeOf, gitlabProjectFromUrl, glabApi, glabError, glabGraphql,
  isGitlabHostIn, isHost, isNamespace, isSegment, normalizeHost, parseGlabHosts, pickForge, splitRemote,
} from './gitlab'
import { line } from './shell'

/** Ported from the tests of `src-tauri/src/gitlab.rs`, plus what only the phone does. */

describe('gitlab hosts', () => {
  it('knows gitlab.com, gitlab.* names and the servers glab is configured for', () => {
    expect(isGitlabHostIn('gitlab.com', [])).toBe(true)
    expect(isGitlabHostIn('gitlab.example.com', [])).toBe(true)
    expect(isGitlabHostIn('gitlab.io', [])).toBe(false)
    expect(isGitlabHostIn('git.example.com', [])).toBe(false)
    expect(isGitlabHostIn('git.example.com', ['git.example.com'])).toBe(true)
    expect(isGitlabHostIn('git.example.com', ['git.example.com:8443'])).toBe(true)
    expect(isGitlabHostIn('github.com', [])).toBe(false)
  })

  it('normalises typed hosts', () => {
    expect(normalizeHost(' https://GitLab.Example.com/foo ')).toBe('gitlab.example.com')
    expect(normalizeHost('git.corp.io:8443')).toBe('git.corp.io:8443')
    expect(normalizeHost('localhost')).toBeNull()
    expect(normalizeHost('evil.com:99999')).toBeNull()
    expect(normalizeHost('-x.com')).toBeNull()
    expect(normalizeHost('a b.com')).toBeNull()
    expect(isHost('$(id).io')).toBe(false)
  })

  it('reads only host names from glab\'s config, never anything else', () => {
    expect(parseGlabHosts('gitlab.com\ngit.corp.io\nGit.Corp.io\n$(id)\ntoken: glpat-x\n\ngit.other.io:8443\n')).toEqual(['git.corp.io', 'git.other.io:8443'])
    // The script prints the keys under `hosts:` only.
    expect(GLAB_HOSTS).toContain('glab-cli}/config.yml')
    expect(GLAB_HOSTS).not.toContain('token')
  })
})

describe('names', () => {
  it('checks segments and namespaces as GitLab does', () => {
    expect(isSegment('my.app_2-x')).toBe(true)
    expect(isSegment('-x')).toBe(false)
    expect(isSegment('.x')).toBe(false)
    expect(isSegment('p.git')).toBe(false)
    expect(isSegment('p.atom')).toBe(false)
    expect(isSegment('a;b')).toBe(false)
    expect(isNamespace('a/b/c')).toBe(true)
    expect(isNamespace('a//b')).toBe(false)
    expect(isNamespace(Array.from({ length: 21 }, () => 'g').join('/'))).toBe(false)
  })

  it('encodes a project path for the REST API', () => {
    expect(encodePath('group/sub/proj')).toBe('group%2Fsub%2Fproj')
    expect(encodePath('v1.2-x_y')).toBe('v1.2-x_y')
    expect(apiProject({ owner: 'group/sub', repo: 'proj' })).toBe('projects/group%2Fsub%2Fproj')
  })
})

describe('the project\'s forge', () => {
  it('reads projects from remotes, nested groups included', () => {
    const f = gitlabProjectFromUrl('git@gitlab.com:group/sub/proj.git', [])!
    expect([f.host, f.owner, f.repo]).toEqual(['gitlab.com', 'group/sub', 'proj'])
    expect(apiProject(f)).toBe('projects/group%2Fsub%2Fproj')
    const g = gitlabProjectFromUrl('ssh://git@git.corp.io:2222/team/app.git', ['git.corp.io'])!
    expect([g.host, `${g.owner}/${g.repo}`]).toEqual(['git.corp.io', 'team/app'])
    expect(gitlabProjectFromUrl('https://oauth2@gitlab.example.com/a/b/', [])).toMatchObject({ owner: 'a', repo: 'b' })
    expect(gitlabProjectFromUrl('git@altssh.gitlab.com:a/b.git', [])).toMatchObject({ host: 'gitlab.com' })
    expect(gitlabProjectFromUrl('https://git.corp.io/team/app', [])).toBeNull()
    expect(gitlabProjectFromUrl('git@gitlab.com:proj.git', [])).toBeNull()
    expect(gitlabProjectFromUrl('git@gitlab.com:g/-x', [])).toBeNull()
    expect(gitlabProjectFromUrl('/home/me/repo', [])).toBeNull()
    expect(splitRemote('work:o/r')).toBeNull()
    expect(forgeOf('git@ssh.github.com:o/r.git', [])).toMatchObject({ provider: 'github', host: 'github.com' })
  })

  it('chooses a forge as the desktop does', () => {
    const gl = 'origin\tgit@gitlab.com:g/p.git (fetch)\norigin\tgit@gitlab.com:g/p.git (push)\n'
    expect(chooseForge(gl, [])?.provider).toBe('gitlab')
    const both = 'origin\tgit@gitlab.com:g/p.git (fetch)\nmirror\thttps://github.com/o/r (fetch)\n'
    expect(chooseForge(both, [])?.provider).toBe('gitlab')
    const tie = 'a\tgit@gitlab.com:g/p.git (fetch)\nb\thttps://github.com/o/r (fetch)\n'
    expect(chooseForge(tie, [])?.provider).toBe('github')
    expect(chooseForge('origin\thttps://bitbucket.org/o/r (fetch)\n', [])).toBeNull()
    expect(chooseForge('origin\tgit@github.com:o/r.git (fetch)\n', [])).toMatchObject({ provider: 'github', owner: 'o', repo: 'r' })
  })

  it('keeps the phone to github.com on GitHub, and words a project on neither', () => {
    expect(pickForge('origin\tgit@gitlab.com:g/p.git (fetch)\n', [])).toMatchObject({ provider: 'gitlab' })
    expect(() => pickForge(null, [])).toThrow(NO_FORGE)
    expect(() => pickForge('origin\thttps://bitbucket.org/o/r (fetch)\n', [])).toThrow(NO_FORGE)
    expect(() => pickForge('origin\thttps://acme.ghe.com/o/r (fetch)\n', [])).toThrow(/only github\.com/)
  })
})

describe('glab', () => {
  it('builds api calls with raw fields only, every value quoted', () => {
    expect(glabApi('gitlab.com', 'projects/a%2Fb')).toEqual(['glab', 'api', '--hostname', 'gitlab.com', 'projects/a%2Fb'])
    expect(() => glabApi('a;b', 'x')).toThrow()
    const argv = glabGraphql('gitlab.com', 'query { x }', [['fullPath', 'a/b'], ['iid', '@/etc/passwd']])
    expect(argv).not.toContain('-F')
    expect(line(argv)).toContain(" -f iid=@/etc/passwd -f 'query=query { x }'")
  })

  it('words its failures', () => {
    expect(glabError('dev', 'gitlab.com', 127, 'bash: glab: command not found')).toMatch(/not installed in dev\. Install the GitLab CLI component/)
    expect(glabError('dev', 'git.corp.io', 1, 'glab: 401 Unauthorized (HTTP 401)')).toMatch(/not signed in to git\.corp\.io\. Sign in from Mango on your computer/)
    expect(glabError('dev', null, 1, 'Run glab auth login first')).toMatch(/not signed in to gitlab\.com/)
    expect(glabError('dev', 'gitlab.com', 1, 'glab: 404 Not Found (HTTP 404)')).toMatch(/GitLab has no such project or item/)
    expect(glabError('dev', 'gitlab.com', null, '')).toMatch(/interrupted/)
    expect(glabError('dev', 'gitlab.com', 2, '')).toBe('The GitLab CLI failed without saying why (exit code 2).')
  })

  it('makes links absolute on the server, http(s) only', () => {
    expect(absoluteUrl('git.corp.io', '/uploads/a.png')).toBe('https://git.corp.io/uploads/a.png')
    expect(absoluteUrl('x', 'https://a/b')).toBe('https://a/b')
    expect(absoluteUrl('x', 'javascript:alert(1)')).toBeNull()
  })
})
