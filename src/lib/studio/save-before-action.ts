export async function runAfterStudioSave<T>(
  beforeSend: (() => Promise<boolean>) | undefined,
  action: () => Promise<T>,
): Promise<T> {
  if (beforeSend && !(await beforeSend())) {
    throw new Error('The latest wiring could not be saved, so the desk did not run. Your changes are still on this board.');
  }
  return action();
}
