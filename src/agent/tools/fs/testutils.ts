/**
 * Test fixtures for the fs tool lane (todo27). Not imported by production
 * code: lives beside the tools so tsconfig.node typechecks it in CI, but only
 * *.test.ts files consume it. The real PermissionEngine (todo24) satisfies
 * PermissionPort STRUCTURALLY (evaluate/assess/record are its exact public
 * signatures); lane 25's bridge supplies `ask`. This fake records every call
 * so tests can assert the gating order (assess → ask → record) without a
 * SQLite handle.
 */
import type {
  Assessment,
  PermissionAction,
  PermissionDecision,
} from '../../policy/types'
import type { PermissionPort } from './gating'

export type AuditRow = {
  action: PermissionAction
  assessment: Assessment
  detail: Record<string, unknown> | undefined
}

export type FakePermission = {
  readonly port: PermissionPort
  readonly audits: AuditRow[]
  readonly asks: PermissionAction[]
  /** decision assess()/evaluate() return (default 'allow') */
  decision: PermissionDecision
  /** what ask() resolves with; 'throw' rejects like a cancelled dialog */
  userAnswer: PermissionDecision | 'throw'
}

export function fakePermission(): FakePermission {
  const audits: AuditRow[] = []
  const asks: PermissionAction[] = []
  const fake: FakePermission = {
    port: {
      evaluate: () => fake.decision,
      assess: () => ({
        decision: fake.decision,
        rule: null,
        ruleId: null,
        scope: null,
      }),
      record: (action, assessment, detail) => {
        audits.push({ action, assessment, detail })
      },
      ask: async (action, signal) => {
        asks.push(action)
        if (signal.aborted || fake.userAnswer === 'throw') {
          throw new Error('permission dialog cancelled')
        }
        return fake.userAnswer
      },
    },
    audits,
    asks,
    decision: 'allow',
    userAnswer: 'throw',
  }
  return fake
}
