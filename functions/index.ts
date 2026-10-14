import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { serveSite } from "./adapter.mjs";
import { withCors } from "./cors.mjs";
import { handleApp } from "./handler.mjs";

const env = (name: string) => Deno.env.get(name);

// CORS 在最外层：预检不落库，且 503/403 也要带上跨源头，否则浏览器只看到"请求失败"看不到原因。
Deno.serve(withCors(serveSite(handleApp, { createClient, env }), { env }));
