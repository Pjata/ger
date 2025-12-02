import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Effect, Layer } from 'effect'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { GerritApiServiceLive } from '@/api/gerrit'
import { ConfigService } from '@/services/config'
import { generateMockChange } from '@/test-utils/mock-generator'
import type { ChangeInfo } from '@/schemas/gerrit'
import { createMockConfigService } from './helpers/config-mock'

// Track the mock URL to return
let mockGitUrl = ''
let mockGitError: Error | null = null

// Mock child_process exec for git commands BEFORE importing the module
mock.module('node:child_process', () => ({
  exec: (
    _cmd: string,
    callback: (error: Error | null, result: { stdout: string; stderr: string } | null) => void,
  ) => {
    if (mockGitError) {
      callback(mockGitError, null)
    } else {
      callback(null, { stdout: mockGitUrl, stderr: '' })
    }
  },
}))

// Import AFTER mocking
// biome-ignore lint/suspicious/noShadowRestrictedNames: Required for module import order
const { openChangesCommand } = await import('@/cli/commands/open-changes')

// Helper to setup mock git remote response
const setupGitMock = (projectUrl: string) => {
  mockGitUrl = projectUrl
  mockGitError = null
}

const setupGitMockError = (errorMessage: string) => {
  mockGitError = new Error(errorMessage)
  mockGitUrl = ''
}

// Create MSW server
const server = setupServer(
  // Default handler for auth check
  http.get('*/a/accounts/self', ({ request }) => {
    const auth = request.headers.get('Authorization')
    if (!auth || !auth.startsWith('Basic ')) {
      return HttpResponse.text('Unauthorized', { status: 401 })
    }
    return HttpResponse.json({
      _account_id: 1000,
      name: 'Test User',
      email: 'test@example.com',
    })
  }),
)

describe('open-changes command', () => {
  let mockConsoleLog: ReturnType<typeof mock>
  let mockConsoleError: ReturnType<typeof mock>

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'bypass' })
  })

  afterAll(() => {
    server.close()
  })

  beforeEach(() => {
    server.resetHandlers()
    mockGitUrl = ''
    mockGitError = null
    mockConsoleLog = mock(() => {})
    mockConsoleError = mock(() => {})
    console.log = mockConsoleLog
    console.error = mockConsoleError
  })

  afterEach(() => {
    server.resetHandlers()
  })

  describe('project detection', () => {
    test('should detect project from SSH URL', async () => {
      setupGitMock('ssh://gerrit.example.com/my-project\n')

      const mockChanges: ChangeInfo[] = []

      server.use(
        http.get('*/a/changes/', ({ request }) => {
          const url = new URL(request.url)
          const query = url.searchParams.get('q')
          expect(query).toContain('project:my-project')
          expect(query).toContain('status:open')
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )
    })

    test('should detect project from SSH URL with port', async () => {
      setupGitMock('ssh://gerrit.example.com:29418/canvas-lms\n')

      server.use(
        http.get('*/a/changes/', ({ request }) => {
          const url = new URL(request.url)
          const query = url.searchParams.get('q')
          expect(query).toContain('project:canvas-lms')
          return HttpResponse.text(`)]}'\n[]`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )
    })

    test('should detect project from HTTPS URL', async () => {
      setupGitMock('https://gerrit.example.com/a/my-project\n')

      server.use(
        http.get('*/a/changes/', ({ request }) => {
          const url = new URL(request.url)
          const query = url.searchParams.get('q')
          expect(query).toContain('project:my-project')
          return HttpResponse.text(`)]}'\n[]`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )
    })

    test('should handle not being in a git repository', async () => {
      setupGitMockError('fatal: not a git repository')

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      const result = await Effect.runPromise(
        Effect.either(
          openChangesCommand({}).pipe(
            Effect.provide(GerritApiServiceLive),
            Effect.provide(mockConfigLayer),
          ),
        ),
      )

      expect(result._tag).toBe('Left')
    })
  })

  describe('pretty output', () => {
    test('should display open changes with reviewer information', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'Fix authentication bug',
          project: 'test-project',
          status: 'NEW',
          labels: {
            'Code-Review': {
              approved: { _account_id: 1001, name: 'Alice Approver' },
              recommended: { _account_id: 1002, name: 'Bob Reviewer' },
            },
            Verified: {
              approved: { _account_id: 1003, name: 'Jenkins' },
            },
          },
        }),
        generateMockChange({
          _number: 12346,
          subject: 'Add caching layer',
          project: 'test-project',
          status: 'NEW',
          labels: {
            'Code-Review': {
              disliked: { _account_id: 1004, name: 'Carol Critic' },
            },
            Verified: {
              rejected: { _account_id: 1003, name: 'Jenkins' },
            },
          },
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')

      // Check header
      expect(output).toContain('Open Changes for test-project')
      expect(output).toContain('(2)')

      // Check first change
      expect(output).toContain('12345')
      expect(output).toContain('Fix authentication bug')
      expect(output).toContain('Alice Approver')
      expect(output).toContain('Bob Reviewer')
      expect(output).toContain('Jenkins')

      // Check second change with negative votes
      expect(output).toContain('12346')
      expect(output).toContain('Add caching layer')
      expect(output).toContain('Carol Critic')
    })

    test('should show pending indicator when no votes', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'No reviews yet',
          project: 'test-project',
          status: 'NEW',
          labels: {},
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')
      // Should show "no reviewers" when labels are empty
      expect(output).toContain('CR:')
      expect(output).toContain('V:')
    })

    test('should display pending reviewers from all array', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'Change with pending reviewer',
          project: 'test-project',
          status: 'NEW',
          labels: {
            'Code-Review': {
              all: [
                { _account_id: 1001, name: 'Alice Voted', value: 2 },
                { _account_id: 1002, name: 'Bob Pending', value: 0 },
                { _account_id: 1003, name: 'Carol Also Pending' }, // no value = pending
              ],
            },
            Verified: {
              all: [{ _account_id: 1004, name: 'Jenkins', value: 1 }],
            },
          },
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')

      // Check that voted reviewer is shown with vote
      expect(output).toContain('Alice Voted')
      expect(output).toContain('+2')

      // Check that pending reviewers are shown with pending indicator
      expect(output).toContain('Bob Pending')
      expect(output).toContain('Carol Also Pending')
      expect(output).toContain('⏳')
    })

    test('should handle no open changes gracefully', async () => {
      setupGitMock('ssh://gerrit.example.com/empty-project\n')

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n[]`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')
      expect(output).toContain('No open changes for empty-project')
    })
  })

  describe('JSON output', () => {
    test('should output valid JSON with reviewer information', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'Test change',
          project: 'test-project',
          status: 'NEW',
          labels: {
            'Code-Review': {
              approved: { _account_id: 1001, name: 'Alice' },
            },
            Verified: {
              approved: { _account_id: 1002, name: 'Jenkins' },
            },
          },
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({ json: true }).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')
      const parsed = JSON.parse(output)

      expect(parsed.project).toBe('test-project')
      expect(parsed.count).toBe(1)
      expect(parsed.changes).toHaveLength(1)
      expect(parsed.changes[0].number).toBe(12345)
      expect(parsed.changes[0].reviewers['Code-Review']).toHaveLength(1)
      expect(parsed.changes[0].reviewers['Code-Review'][0].name).toBe('Alice')
      expect(parsed.changes[0].reviewers['Code-Review'][0].value).toBe(2)
      expect(parsed.changes[0].reviewers.Verified).toHaveLength(1)
    })

    test('should include pending flag in JSON output', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'Test change',
          project: 'test-project',
          status: 'NEW',
          labels: {
            'Code-Review': {
              all: [
                { _account_id: 1001, name: 'Alice', value: 1 },
                { _account_id: 1002, name: 'Bob', value: 0 },
              ],
            },
            Verified: {},
          },
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({ json: true }).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')
      const parsed = JSON.parse(output)

      expect(parsed.changes[0].reviewers['Code-Review']).toHaveLength(2)
      // Alice voted, not pending
      expect(parsed.changes[0].reviewers['Code-Review'][0].name).toBe('Alice')
      expect(parsed.changes[0].reviewers['Code-Review'][0].pending).toBe(false)
      // Bob didn't vote, is pending
      expect(parsed.changes[0].reviewers['Code-Review'][1].name).toBe('Bob')
      expect(parsed.changes[0].reviewers['Code-Review'][1].pending).toBe(true)
    })
  })

  describe('XML output', () => {
    test('should output valid XML with reviewer information', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'Test change',
          project: 'test-project',
          status: 'NEW',
          labels: {
            'Code-Review': {
              recommended: { _account_id: 1001, name: 'Bob' },
            },
            Verified: {},
          },
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({ xml: true }).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')

      expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>')
      expect(output).toContain('<open_changes project="test-project" count="1">')
      expect(output).toContain('<change>')
      expect(output).toContain('<number>12345</number>')
      expect(output).toContain('<subject><![CDATA[Test change]]></subject>')
      expect(output).toContain('<reviewers>')
      expect(output).toContain('<label name="Code-Review">')
      expect(output).toContain('<vote name="Bob" value="+1"/>')
      expect(output).toContain('</open_changes>')
    })

    test('should escape XML special characters in subject', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'Fix <script>alert("XSS")</script> & entities',
          project: 'test-project',
          status: 'NEW',
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({ xml: true }).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')
      // CDATA should preserve special characters
      expect(output).toContain('<![CDATA[Fix <script>alert("XSS")</script> & entities]]>')
    })
  })

  describe('limit option', () => {
    test('should respect limit parameter in query', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      server.use(
        http.get('*/a/changes/', ({ request }) => {
          const url = new URL(request.url)
          const query = url.searchParams.get('q')
          expect(query).toContain('limit:5')
          return HttpResponse.text(`)]}'\n[]`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({ limit: 5 }).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )
    })

    test('should default to limit of 20', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      server.use(
        http.get('*/a/changes/', ({ request }) => {
          const url = new URL(request.url)
          const query = url.searchParams.get('q')
          expect(query).toContain('limit:20')
          return HttpResponse.text(`)]}'\n[]`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )
    })
  })

  describe('error handling', () => {
    test('should handle network failures', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.error()
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      const result = await Effect.runPromise(
        Effect.either(
          openChangesCommand({}).pipe(
            Effect.provide(GerritApiServiceLive),
            Effect.provide(mockConfigLayer),
          ),
        ),
      )

      expect(result._tag).toBe('Left')
    })

    test('should handle authentication failures', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text('Unauthorized', { status: 401 })
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      const result = await Effect.runPromise(
        Effect.either(
          openChangesCommand({}).pipe(
            Effect.provide(GerritApiServiceLive),
            Effect.provide(mockConfigLayer),
          ),
        ),
      )

      expect(result._tag).toBe('Left')
    })
  })

  describe('sorting', () => {
    test('should sort changes by most recently updated first', async () => {
      setupGitMock('ssh://gerrit.example.com/test-project\n')

      const mockChanges: ChangeInfo[] = [
        generateMockChange({
          _number: 12345,
          subject: 'Older change',
          project: 'test-project',
          updated: '2024-01-01 10:00:00.000000000',
        }),
        generateMockChange({
          _number: 12346,
          subject: 'Newer change',
          project: 'test-project',
          updated: '2024-01-15 10:00:00.000000000',
        }),
        generateMockChange({
          _number: 12347,
          subject: 'Middle change',
          project: 'test-project',
          updated: '2024-01-08 10:00:00.000000000',
        }),
      ]

      server.use(
        http.get('*/a/changes/', () => {
          return HttpResponse.text(`)]}'\n${JSON.stringify(mockChanges)}`)
        }),
      )

      const mockConfigLayer = Layer.succeed(ConfigService, createMockConfigService())
      await Effect.runPromise(
        openChangesCommand({}).pipe(
          Effect.provide(GerritApiServiceLive),
          Effect.provide(mockConfigLayer),
        ),
      )

      const output = mockConsoleLog.mock.calls.map((call) => call[0]).join('\n')

      // Newer should appear before older
      const newerPos = output.indexOf('Newer change')
      const middlePos = output.indexOf('Middle change')
      const olderPos = output.indexOf('Older change')

      expect(newerPos).toBeLessThan(middlePos)
      expect(middlePos).toBeLessThan(olderPos)
    })
  })
})
