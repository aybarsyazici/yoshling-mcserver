package xyz.yoshling.screenshots;

import java.time.Duration;

/** Memory-only grant and request generations; contains no filesystem or game APIs. */
public final class CaptureSession {
    public static final long WORLD_DELAY = Duration.ofSeconds(20).toNanos();
    public static final long PAIR_DELAY = Duration.ofSeconds(3).toNanos();
    public static final long LOCAL_EXPIRY = Duration.ofMinutes(15).toNanos();
    public enum Stage { WAITING, CONTEXT, READY, CAPTURING, UPLOADING }
    public record Job(long generation, String code) {
        @Override public String toString() { return "CaptureJob[" + generation + "]"; }
    }
    public record Frame(Job job, CaptureProtocol.Context context) {}
    private Object connection, world;
    private String code;
    private long worldSince, pairedAt, generation;
    private boolean autoAttempted, manualRequested;
    private Stage stage = Stage.WAITING;
    private CaptureProtocol.Context pinned;

    public synchronized void observe(Object connection, Object world, long now) {
        if (connection == null || world == null || this.connection != connection) {
            clear();
            this.connection = connection; this.world = world; worldSince = now;
        } else if (this.world != world) {
            generation++; this.world = world; worldSince = now;
            stage = Stage.WAITING; manualRequested = false;
        }
        if (code != null && now - pairedAt >= LOCAL_EXPIRY) clear();
    }
    public synchronized void pair(String code, long now) {
        if (!LocalCommand.validCode(code) || connection == null || world == null)
            throw new IllegalArgumentException("Join the supported server before pairing.");
        clear(); this.code = code; pairedAt = now;
    }
    public synchronized boolean requestManual() {
        if (code == null || stage != Stage.WAITING) return false;
        manualRequested = true; return true;
    }
    public synchronized Job next(long now, boolean screenClosed) {
        if (code == null || stage != Stage.WAITING || !screenClosed ||
                now - pairedAt < PAIR_DELAY || now - pairedAt >= LOCAL_EXPIRY ||
                (!manualRequested && (autoAttempted || now - worldSince < WORLD_DELAY))) return null;
        manualRequested = false; autoAttempted = true; stage = Stage.CONTEXT;
        return new Job(generation, code);
    }
    public synchronized boolean current(Job job) {
        return code != null && job.generation() == generation && code.equals(job.code());
    }
    /** Call from the client thread, which owns generation changes and queue publication. */
    public boolean dispatch(Job job, Runnable action, Runnable discard) {
        if (!current(job)) { discard.run(); return false; }
        action.run(); return true;
    }
    public synchronized boolean accept(Job job, CaptureProtocol.Context context) {
        if (!current(job) || stage != Stage.CONTEXT) return false;
        if (pinned != null) CaptureProtocol.sameContext(pinned, context);
        pinned = context;
        if (!context.complete()) stage = Stage.READY;
        return true;
    }
    public synchronized Frame frame() {
        if (code == null || stage != Stage.READY || pinned == null) return null;
        stage = Stage.CAPTURING; return new Frame(new Job(generation, code), pinned);
    }
    public synchronized boolean upload(Job job) {
        if (!current(job) || stage != Stage.CAPTURING) return false;
        stage = Stage.UPLOADING; return true;
    }
    public synchronized boolean finish(Job job) {
        if (!current(job)) return false;
        clear(); return true;
    }
    public synchronized boolean readFailed(Job job, boolean refused) {
        if (!current(job)) return false;
        if (refused) clear(); else stage = Stage.WAITING;
        return true;
    }
    public synchronized boolean paired() { return code != null; }
    public synchronized Stage stage() { return stage; }
    public synchronized void clear() {
        generation++; code = null; pinned = null; stage = Stage.WAITING;
        autoAttempted = false; manualRequested = false;
    }
}
