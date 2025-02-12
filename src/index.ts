import fetch from "./fetch";

function modify_env(env: Env): Env {
	function set_defaults<T>(o: T, k: keyof T, defaults: any) {
		if (typeof o[k] === "undefined") o[k] = defaults;
	}
	set_defaults(env.cors, "hijack_options", false)
	set_defaults(env.cors, "advanced_allow_origins", false)
	return env;
}

function handle_advanced_allow_origins(origin: string | null | undefined, headers: Headers, env: Env) {
	if (env.cors.advanced_allow_origins === false) return;
	if (!origin) return;
	if (env.cors.advanced_allow_origins!.includes(origin)) {
		headers.set("Access-Control-Allow-Origin", origin);
	}
}

function hijack_options(request: Request, env: Env): Response {
	const headers = new Headers();
	for (const [k, v] of Object.entries(env.cors.options_headers)) {
		headers.append(k, v);
	}
	handle_advanced_allow_origins(request.headers.get("Origin"), headers, env);
	return new Response(null, { status: 204, headers });
}

async function handle_request(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	modify_env(env);

	const method = request.method.toUpperCase();
	const in_origin = request.headers.get("Origin");
	console.log(in_origin)

	const new_req_headers = new Headers(request.headers);

	// OPTIONS requests
	if (method === "OPTIONS" && env.cors.hijack_options!) {
		return hijack_options(request, env);

	}

	// normal requests
	if (env.proxy_host) new_req_headers.set("Host", env.proxy_host);
	env.request.delete_headers.forEach(h => new_req_headers.delete(h));
	Object.entries(env.request.add_headers).forEach(([k, v]) => new_req_headers.append(k, v));

	// send request
	const u = new URL(request.url, env.proxy_baseurl);
	const url = env.proxy_baseurl + u.pathname + u.search;
	const new_request = new Request(request, {
		headers: new_req_headers,
		redirect: "manual"
	});
	const resp = await fetch(url, new_request).then(async res => {
		const new_response = new Response(res.body, res);
		env.response.delete_headers.forEach(h => new_response.headers.delete(h));
		Object.entries(env.response.add_headers).forEach(([k, v]) => new_response.headers.append(k, v));
		handle_advanced_allow_origins(in_origin, new_response.headers, env);
		return new_response;
	})
	return resp;
}

export default {
	fetch: handle_request,
} satisfies ExportedHandler<Env>;
