package xyz.yoshling.screenshots;

import java.io.IOException;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;

/** Bounded asynchronous body; the whole HTTP exchange also has a deadline. */
public final class ResponseBody implements HttpResponse.BodySubscriber<String> {
    private final CompletableFuture<String> complete = new CompletableFuture<>();
    private final BoundedBytes bytes;
    private Flow.Subscription subscription;
    public ResponseBody(int limit) { bytes = new BoundedBytes(limit); }
    @Override public CompletionStage<String> getBody() { return complete; }
    @Override public void onSubscribe(Flow.Subscription subscription) {
        if (this.subscription != null) { subscription.cancel(); return; }
        this.subscription = subscription; subscription.request(1);
    }
    @Override public void onNext(List<ByteBuffer> blocks) {
        if (complete.isDone()) return;
        try { for (ByteBuffer block : blocks) bytes.write(block); subscription.request(1); }
        catch (IOException failure) { subscription.cancel(); complete.completeExceptionally(failure); }
    }
    @Override public void onError(Throwable ignored) { complete.completeExceptionally(new IOException("Unconfirmed capture response.")); }
    @Override public void onComplete() {
        try { complete.complete(new String(bytes.bytes(), StandardCharsets.UTF_8)); }
        catch (IOException failure) { complete.completeExceptionally(failure); }
        finally { bytes.close(); }
    }
}
