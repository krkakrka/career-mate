export function notImplemented(commandPath: string): () => void {
  return () => {
    console.error(`cm ${commandPath}: not yet implemented`);
    process.exitCode = 1;
  };
}
