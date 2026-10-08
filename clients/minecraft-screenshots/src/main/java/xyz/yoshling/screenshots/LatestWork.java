package xyz.yoshling.screenshots;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** At most one running task and one queued task, with explicit native-image disposal. */
public final class LatestWork implements AutoCloseable {
    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), task -> {
                Thread thread = new Thread(task, "yoshling-screenshot-upload"); thread.setDaemon(true); return thread;
            }, new ThreadPoolExecutor.AbortPolicy());
    public synchronized boolean submit(Runnable action, Runnable discard) {
        Runnable old;
        while ((old = executor.getQueue().poll()) != null) ((Task) old).discard();
        Task task = new Task(action, discard);
        try { executor.execute(task); return true; }
        catch (RejectedExecutionException failure) { task.discard(); return false; }
    }
    @Override public synchronized void close() {
        for (Runnable task : executor.shutdownNow()) ((Task) task).discard();
    }
    private static final class Task implements Runnable {
        private final Runnable action, dispose;
        private final AtomicBoolean claimed = new AtomicBoolean();
        private Task(Runnable action, Runnable dispose) { this.action = action; this.dispose = dispose; }
        @Override public void run() { if (claimed.compareAndSet(false, true)) action.run(); }
        private void discard() { if (claimed.compareAndSet(false, true)) dispose.run(); }
    }
}
