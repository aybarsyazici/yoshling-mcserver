package xyz.yoshling.screenshots;

import java.util.Locale;
import java.util.regex.Pattern;

/** Handles the entire local command namespace, including invalid inputs. */
public record LocalCommand(Kind kind, String code) {
    public enum Kind { PAIR, CAPTURE, HELP }
    private static final Pattern CODE = Pattern.compile("[A-Za-z0-9_-]{43}");

    public static boolean validCode(String code) {
        return code != null && CODE.matcher(code).matches();
    }
    public static LocalCommand parseChat(String input) {
        return input != null && input.strip().startsWith("/") ? parse(input) : null;
    }

    public static LocalCommand parse(String input) {
        if (input == null) return null;
        String text = input.strip();
        if (text.startsWith("/")) text = text.substring(1);
        String[] parts = text.split("\\s+");
        if (parts.length == 0 || !parts[0].toLowerCase(Locale.ROOT).equals("yoshling")) return null;
        if (parts.length == 2 && parts[1].equalsIgnoreCase("capture")) return new LocalCommand(Kind.CAPTURE, null);
        if (parts.length == 3 && parts[1].equalsIgnoreCase("pair") && validCode(parts[2])) return new LocalCommand(Kind.PAIR, parts[2]);
        return new LocalCommand(Kind.HELP, null);
    }

    @Override public String toString() { return "LocalCommand[" + kind + "]"; }
}
