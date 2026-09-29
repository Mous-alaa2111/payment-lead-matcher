// Public base URL of the app (also Better Auth's base URL). Set per environment.
export function appUrl(path = "") {
  const base = process.env.BETTER_AUTH_URL;
  if (!base) throw new Error("BETTER_AUTH_URL is not set");
  return new URL(path, base).toString();
}
