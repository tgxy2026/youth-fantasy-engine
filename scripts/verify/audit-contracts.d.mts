export function validateAuditBundle(root: string, directory: string, expected: {
  inputHash: string; sourceFingerprint: string
}): Promise<number>
