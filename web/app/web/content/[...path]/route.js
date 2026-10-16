import { cookies } from "next/headers";
import { odooPassthrough, SESSION_COOKIE } from "@/lib/odoo";

export const dynamic = "force-dynamic";

/* /web/content/<attachment id>/<name> — task attachments, with the session. */
export async function GET(req, ctx) {
  const { path } = await ctx.params;
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  return odooPassthrough(req, "/web/content/" + path.map(encodeURIComponent).join("/"), session);
}
