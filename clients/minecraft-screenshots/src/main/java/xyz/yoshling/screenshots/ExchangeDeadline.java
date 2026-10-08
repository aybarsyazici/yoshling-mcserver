package xyz.yoshling.screenshots;

import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

public final class ExchangeDeadline {
    private ExchangeDeadline() {}
    public static <T> T await(CompletableFuture<T> exchange, Duration timeout) throws IOException, InterruptedException {
        try { return exchange.get(timeout.toMillis(), TimeUnit.MILLISECONDS); }
        catch (TimeoutException failure) { exchange.cancel(true); throw new IOException("Capture response timed out."); }
        catch (InterruptedException failure) { exchange.cancel(true); Thread.currentThread().interrupt(); throw failure; }
        catch (ExecutionException failure) { throw new IOException("Unconfirmed capture response."); }
    }
}
