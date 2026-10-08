package xyz.yoshling.screenshots;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

public final class CaptureProtocol {
    public static final String VERSION = "26.1.2";
    public static final URI CONTEXT_URI = URI.create("https://yoshling.xyz/api/minecraft/capture/context");
    public static final URI UPLOAD_URI = URI.create("https://yoshling.xyz/api/minecraft/capture");
    public static final int MAX_BYTES = 5 * 1024 * 1024;
    public static final int MAX_PIXELS = 16_000_000;
    public static final int OUTPUT_WIDTH = 1280;
    public static final int OUTPUT_HEIGHT = 800;
    private CaptureProtocol() {}

    public record Context(String sessionId, String profileId, String profileName, String contextToken,
                          int profileRevision, Instant expiresAt, boolean complete) {}

    public static String serverAddress(String value) {
        if (value == null) throw new IllegalArgumentException("Connect to the Yoshling Minecraft server first.");
        String address = value.strip().toLowerCase(Locale.ROOT);
        if (!address.matches("(mc\\.yoshling\\.xyz|89\\.58\\.50\\.155)(:25565)?"))
            throw new IllegalArgumentException("Connect directly to mc.yoshling.xyz on port 25565.");
        return address.contains(":") ? address : address + ":25565";
    }

    public static void requireVersion(String value) {
        if (!VERSION.equals(value)) throw new IllegalArgumentException("This companion supports Minecraft 26.1.2 only.");
    }

    public static Context context(String json) {
        JsonObject body = object(JsonParser.parseString(json));
        require(integer(body, "protocol") == 1, "Unsupported capture protocol.");
        String state = string(body, "state", 16);
        require(state.equals("waiting") || state.equals("complete"), "Unconfirmed capture context.");
        String sessionId = string(body, "sessionId", 128), profileId = uuid(body, "profileId");
        require(sessionId.matches("[A-Za-z0-9_-]+"), "Unconfirmed capture session.");
        String token = string(body, "contextToken", 512);
        require(token.startsWith(profileId + "@") && token.matches("[A-Za-z0-9_@.:-]+"), "Unconfirmed Minecraft identity.");
        require(integer(body, "maxBytes") == MAX_BYTES && integer(body, "maxPixels") == MAX_PIXELS, "Unsupported capture bounds.");
        require(string(body, "uploadUrl", 512).equals(UPLOAD_URI.toString()), "Unconfirmed upload destination.");
        int revision = integer(body, "profileRevision");
        require(revision > 0 && revision < Integer.MAX_VALUE, "Unconfirmed profile revision.");
        Context context = new Context(sessionId, profileId, string(body, "profileName", 80), token,
                revision, Instant.parse(string(body, "expiresAt", 80)), state.equals("complete"));
        if (context.complete()) receipt(body, context);
        return context;
    }

    public static void sameContext(Context original, Context latest) {
        require(original.sessionId().equals(latest.sessionId()) &&
                original.profileId().equals(latest.profileId()) &&
                original.contextToken().equals(latest.contextToken()) &&
                original.profileRevision() == latest.profileRevision() &&
                original.expiresAt().equals(latest.expiresAt()), "The paired profile changed. Pair again from the dashboard.");
    }

    public static void receipt(String json, Context expected) { receipt(object(JsonParser.parseString(json)), expected); }
    private static void receipt(JsonObject body, Context expected) {
        require(integer(body, "protocol") == 1 && string(body, "state", 16).equals("complete") &&
                booleanValue(body, "verified") && string(body, "sessionId", 128).equals(expected.sessionId()) &&
                uuid(body, "profileId").equals(expected.profileId()), "The screenshot result is unconfirmed.");
        JsonObject profile = object(body.get("profile"));
        require(uuid(profile, "id").equals(expected.profileId()) &&
                integer(profile, "revision") == expected.profileRevision() + 1, "The screenshot profile receipt is unconfirmed.");
        String url = string(profile, "coverUrl", 512);
        require(url.equals("/api/minecraft/profiles/" + expected.profileId() + "/cover?v=" + (expected.profileRevision() + 1)),
                "The screenshot cover receipt is unconfirmed.");
    }

    public static int downscale(int width, int height) {
        require(width > 0 && height > 0 && (long) width * height <= MAX_PIXELS,
                "The game window is too large. Resize it before capturing.");
        int scale = Math.max(1, Math.max((width + OUTPUT_WIDTH - 1) / OUTPUT_WIDTH, (height + OUTPUT_HEIGHT - 1) / OUTPUT_HEIGHT));
        // Vanilla requires an exact divisor; odd window sizes are resized after readback.
        return width % scale == 0 && height % scale == 0 ? scale : 1;
    }
    public record Size(int width, int height) {}
    public static Size outputSize(int width, int height) {
        downscale(width, height);
        double scale = Math.min(1, Math.min((double) OUTPUT_WIDTH / width, (double) OUTPUT_HEIGHT / height));
        return new Size(Math.max(1, (int) (width * scale)), Math.max(1, (int) (height * scale)));
    }
    private static JsonObject object(JsonElement value) { require(value != null && value.isJsonObject(), "Unconfirmed capture response."); return value.getAsJsonObject(); }
    private static String string(JsonObject body, String key, int limit) {
        JsonElement value = body.get(key);
        require(value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString(), "Unconfirmed capture response.");
        String result = value.getAsString(); require(!result.isEmpty() && result.length() <= limit, "Unconfirmed capture response."); return result;
    }
    private static int integer(JsonObject body, String key) {
        JsonElement value = body.get(key);
        require(value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber(), "Unconfirmed capture response.");
        try { return value.getAsBigDecimal().intValueExact(); } catch (ArithmeticException error) { throw new IllegalArgumentException("Unconfirmed capture response."); }
    }
    private static boolean booleanValue(JsonObject body, String key) {
        JsonElement value = body.get(key);
        require(value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean(), "Unconfirmed capture response."); return value.getAsBoolean();
    }
    private static String uuid(JsonObject body, String key) {
        String value = string(body, key, 36); require(value.length() == 36 && UUID.fromString(value).toString().equals(value), "Unconfirmed capture response."); return value;
    }
    private static void require(boolean condition, String message) { if (!condition) throw new IllegalArgumentException(message); }
}
