package xyz.yoshling.screenshots;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/** Fixed HTTPS destinations, no cookies, redirects, tokens in URLs, or logging. */
public final class CaptureHttp {
    private static final int MAX_RESPONSE = 64 * 1024;
    private final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();

    public static final class Refused extends IOException {
        private final int status;
        public Refused(int status) { super("Capture refused (HTTP " + status + ")."); this.status = status; }
        public int status() { return status; }
    }

    public CaptureProtocol.Context context(String code, String address) throws IOException, InterruptedException {
        requireCode(code);
        JsonObject body = new JsonObject();
        body.addProperty("protocol", 1); body.addProperty("minecraftVersion", CaptureProtocol.VERSION);
        body.addProperty("serverAddress", CaptureProtocol.serverAddress(address));
        HttpRequest request = HttpRequest.newBuilder(CaptureProtocol.CONTEXT_URI)
                .timeout(Duration.ofSeconds(15)).header("Authorization", "Bearer " + code)
                .header("Content-Type", "application/json").header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body.toString(), StandardCharsets.UTF_8)).build();
        return CaptureProtocol.context(send(request));
    }
    public void upload(String code, CaptureProtocol.Context context, byte[] png) throws IOException, InterruptedException {
        requireCode(code);
        if (png.length == 0 || png.length > CaptureProtocol.MAX_BYTES) throw new IOException("Screenshot exceeds the upload bound.");
        HttpRequest request = HttpRequest.newBuilder(CaptureProtocol.UPLOAD_URI)
                .timeout(Duration.ofSeconds(30)).header("Authorization", "Bearer " + code)
                .header("Content-Type", "image/png").header("Accept", "application/json")
                .header("X-Minecraft-Context", context.contextToken())
                .header("X-Minecraft-Profile", context.profileId())
                .header("X-Profile-Revision", Integer.toString(context.profileRevision()))
                .POST(HttpRequest.BodyPublishers.ofByteArray(png)).build();
        CaptureProtocol.receipt(send(request), context);
    }
    private String send(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> response = ExchangeDeadline.await(
                client.sendAsync(request, info -> new ResponseBody(MAX_RESPONSE)), request.timeout().orElse(Duration.ofSeconds(15)));
        if (response.statusCode() >= 400 && response.statusCode() < 500 && response.statusCode() != 408) throw new Refused(response.statusCode());
        if (response.statusCode() < 200 || response.statusCode() >= 300 ||
                !response.headers().firstValue("Content-Type").orElse("").toLowerCase(java.util.Locale.ROOT).startsWith("application/json"))
            throw new IOException("Unconfirmed capture response.");
        return response.body();
    }
    private static void requireCode(String code) { if (!LocalCommand.validCode(code)) throw new IllegalArgumentException("Pair from the dashboard first."); }
}
