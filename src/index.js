/**
 * Cloudflare Worker: RSS Bridge for SnagFlow (Premium Edition)
 * 
 * 功能：
 * 1. GET /feed?id=xxx - 获取 RSS XML 内容 (带 ETag 缓存优化)
 * 2. HEAD /feed?id=xxx - 检查订阅源状态
 * 3. POST /update?id=xxx - 更新 RSS 内容 (由插件调用)
 */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const id = url.searchParams.get("id");

        // 处理根路径，提供友好提示
        if (url.pathname === "/" || url.pathname === "") {
            return new Response("SnagFlow RSS Bridge is operational. Use /feed?id=YOUR_ID to subscribe.", {
                status: 200,
                headers: { "Content-Type": "text/plain" }
            });
        }

        if (!id) {
            return new Response("Missing feed ID", { status: 400 });
        }

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "X-Content-Type-Options": "nosniff",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        // 1. 获取订阅内容 (GET / HEAD)
        if (request.method === "GET" || request.method === "HEAD") {
            // 获取带元数据的 KV 内容
            const { value: feedContent, metadata } = await env.RSS_CACHE.getWithMetadata(`feed_${id}`);

            if (!feedContent) {
                return new Response("Feed not found", { status: 404, headers: corsHeaders });
            }

            // 生成/获取 ETag (使用内容的哈希或元数据中的时间戳)
            const etag = `W/"${metadata?.hash || btoa(id).slice(0, 8)}"`;
            
            // 检查 If-None-Match 头部实现 304 缓存
            if (request.headers.get("If-None-Match") === etag) {
                return new Response(null, { status: 304, headers: { ...corsHeaders, "ETag": etag } });
            }

            const responseHeaders = {
                ...corsHeaders,
                "Content-Type": "application/xml; charset=utf-8",
                "Cache-Control": "public, max-age=300",
                "ETag": etag,
            };

            if (request.method === "HEAD") {
                return new Response(null, { headers: responseHeaders });
            }

            return new Response(feedContent, { headers: responseHeaders });
        }

        // 2. 更新订阅内容 (POST)
        if (request.method === "POST") {
            const authHeader = request.headers.get("Authorization");
            if (env.AUTH_TOKEN && authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
                return new Response("Unauthorized", { status: 401, headers: corsHeaders });
            }

            try {
                const body = await request.text();
                // 增强校验：长度 + 基本 XML 格式
                if (!body || body.length < 100 || !body.includes("<?xml")) {
                    return new Response("Invalid RSS content format", { status: 400, headers: corsHeaders });
                }

                // 计算内容摘要作为 ETag 标识 (SHA-1 足够快速且胜任指纹用途)
                const hashBuffer = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
                const hash = Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);

                // 存入 KV，并附带哈希元数据
                await env.RSS_CACHE.put(`feed_${id}`, body, {
                    metadata: { hash, updatedAt: Date.now() }
                });

                return new Response("Success", { headers: corsHeaders });
            } catch (err) {
                return new Response("Update failed: " + err.message, { status: 500, headers: corsHeaders });
            }
        }

        return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    },
};
