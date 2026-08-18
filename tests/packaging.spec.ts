// Packaging consistency guards. The v0.1.4 release shipped two defects that
// every existing check missed: the bundled-runtime version constant drifted
// from the runtime actually packaged (boot failed with "expected 4.132.0-dsh.3"
// against a dsh.4 runtime), and `extension/prompt.js` was absent from the npm
// `files` list so the packaged extension crashed at require('./prompt'). These
// specs pin the invariants that would have caught both.
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

async function readProjectFile(path: string): Promise<string> {
  return readFile(resolve(ROOT, path), 'utf8')
}

async function readVersionConstant(): Promise<string> {
  const source = await readProjectFile('src/index.ts')
  const match = /BUNDLED_CODE_SERVER_VERSION = '([^']+)'/.exec(source)
  expect(match, 'src/index.ts must declare BUNDLED_CODE_SERVER_VERSION').not.toBeNull()
  return match![1]
}

describe('bundled runtime version single-sourcing', () => {
  it('package.json metadata matches the src constant', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as {
      dsh: { bundledCodeServerVersion: string }
    }
    expect(manifest.dsh.bundledCodeServerVersion).toBe(await readVersionConstant())
  })

  it('the packaging script derives the version from src instead of hardcoding it', async () => {
    const script = await readProjectFile('scripts/package-runtimes.sh')
    expect(script).not.toMatch(/^code_server_version=\d/m)
    expect(script).toMatch(/BUNDLED_CODE_SERVER_VERSION/)
    expect(script).toMatch(/code_server_version=\$\(node -p/)
  })

  it('the release smoke derives its expectation from the archive, not a literal', async () => {
    const workflow = await readProjectFile('.github/workflows/release.yml')
    expect(workflow).not.toMatch(/grep ['"]?\^4\.132\.0-dsh\.\d/)
    expect(workflow).toMatch(/expected_runtime=/)
  })
})

describe('packaged extension completeness', () => {
  /** npm `files` entries: exact paths, directory roots, and `**` globs. */
  function coveredByFiles(entry: string, files: readonly string[]): boolean {
    return files.some(pattern => {
      if (!pattern.includes('*')) return pattern === entry || entry.startsWith(`${pattern}/`)
      const regex = new RegExp(
        `^${pattern.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`,
      )
      return regex.test(entry)
    })
  }

  it('ships every local module the extension requires at activation time', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as { files: string[] }
    const source = await readProjectFile('extension/extension.js')
    const required = [...source.matchAll(/require\('\.\/([^']+)'\)/g)].map(m => m[1])
    for (const name of required) {
      for (const candidate of [name, `${name}.js`]) {
        const entry = `extension/${candidate}`
        if (existsSync(resolve(ROOT, 'extension', candidate))) {
          expect(
            coveredByFiles(entry, manifest.files),
            `${entry} exists in extension/ but is not covered by package.json files`,
          ).toBe(true)
        }
      }
    }
  })

  it('ships every extension asset referenced from the extension URI', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as { files: string[] }
    const source = await readProjectFile('extension/extension.js')
    const referenced = [...source.matchAll(/joinPath\(context\.extensionUri,\s*'([^']+)'\)/g)].map(m => m[1])
    expect(referenced.length, 'extension should reference at least its icon').toBeGreaterThan(0)
    for (const name of referenced) {
      expect(
        existsSync(resolve(ROOT, 'extension', name)),
        `extension/${name} is referenced but missing from extension/`,
      ).toBe(true)
      expect(
        coveredByFiles(`extension/${name}`, manifest.files),
        `extension/${name} is referenced but not covered by package.json files`,
      ).toBe(true)
    }
  })

  it('routes editor chat through DSH without contributing a panel participant', async () => {
    const extensionManifest = JSON.parse(await readProjectFile('extension/package.json')) as {
      contributes: {
        chatParticipants: { locations: string[] }[]
        languageModelChatProviders: { vendor: string; isDefault: boolean }[]
      }
    }
    expect(extensionManifest.contributes.chatParticipants[0]?.locations).toEqual(['editor', 'terminal'])
    expect(extensionManifest.contributes.languageModelChatProviders).toContainEqual({
      vendor: 'copilot',
      displayName: 'DSH',
      isDefault: true,
    })

    const source = await readProjectFile('extension/extension.js')
    expect(source).toContain("registerLanguageModelChatProvider('copilot'")
    expect(source).toContain("getConfiguration('chat.editor.localAgent')")
    expect(source).toContain("getConfiguration('workbench.secondarySideBar')")
    expect(source).toContain("executeCommand('workbench.action.closeAuxiliaryBar')")
  })

  it('ships the extension entry, host lib, patch and launcher the profile boots', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as { files: string[] }
    for (const entry of [
      'extension/extension.js',
      'extension/package.json',
      'lib/index.js',
      'lib/client.js',
      'bin/dsh-code-server-runtime',
      'cordis.patch.yml',
    ]) {
      expect(manifest.files, `${entry} must stay in files`).toContain(entry)
    }
  })

  it('keeps every file in extension/ packaged or intentionally local', async () => {
    const manifest = JSON.parse(await readProjectFile('package.json')) as { files: string[] }
    const names = await readdir(resolve(ROOT, 'extension'))
    for (const name of names) {
      expect(
        coveredByFiles(`extension/${name}`, manifest.files),
        `extension/${name} exists in the repo but is not packaged; add it to files or remove it`,
      ).toBe(true)
    }
  })
})
