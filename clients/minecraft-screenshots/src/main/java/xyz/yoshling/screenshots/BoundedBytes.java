package xyz.yoshling.screenshots;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.WritableByteChannel;

/** The encoder may catch callback exceptions, so remember failure for final readback. */
public final class BoundedBytes implements WritableByteChannel {
    private final ByteArrayOutputStream output = new ByteArrayOutputStream();
    private final int limit;
    private boolean open = true;
    private IOException failure;
    public BoundedBytes(int limit) {
        if (limit < 1 || limit > CaptureProtocol.MAX_BYTES) throw new IllegalArgumentException("Invalid byte bound.");
        this.limit = limit;
    }
    @Override public int write(ByteBuffer source) throws IOException {
        int count = source.remaining();
        if (!open || (long) output.size() + count > limit) {
            failure = new IOException("Output exceeds its byte bound."); throw failure;
        }
        byte[] block = new byte[Math.min(8192, count)];
        while (source.hasRemaining()) {
            int length = Math.min(block.length, source.remaining()); source.get(block, 0, length); output.write(block, 0, length);
        }
        return count;
    }
    public byte[] bytes() throws IOException { if (failure != null) throw failure; return output.toByteArray(); }
    @Override public boolean isOpen() { return open; }
    @Override public void close() { open = false; }
}
