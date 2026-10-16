import { cookies } from "next/headers";
import { odooPassthrough, SESSION_COOKIE } from "@/lib/odoo";

export const dynamic = "force-dynamic";

/* /web/image/res.users/7/avatar_128 and friends, with the session attached. */
export async function GET(req, ctx) {
  const { path } = await ctx.params;
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  return odooPassthrough(req, "/web/image/" + path.map(encodeURIComponent).join("/"), session);
}
