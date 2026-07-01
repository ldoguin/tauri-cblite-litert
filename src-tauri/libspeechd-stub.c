/*
 * libspeechd-stub.c — full-coverage stub for libspeechd.so.2.
 *
 * Provides every public symbol from libspeechd 0.12.x so the dynamic linker
 * is satisfied even when speech-dispatcher is not installed.  All functions
 * return failure codes / NULL; the TTS plugin initialises to an error and
 * the app falls back to its Xenova-based TTS path.
 *
 * Generated from: nm -D /usr/lib/x86_64-linux-gnu/libspeechd.so.2 | grep ' T '
 */
#include <stddef.h>
#include <stdlib.h>
#include <wchar.h>

typedef void  SPDConnection;
typedef int   SPDPriority;
typedef int   SPDVoiceType;
typedef int   SPDDataMode;
typedef int   SPDNotification;
typedef int   SPDSpelling;
typedef int   SPDPunctuation;
typedef int   SPDCapitalLetters;
typedef int   SPDConnectionMode;
typedef void (*SPDCallback)(size_t, size_t, SPDNotification);

typedef struct { char *name; char *language; char *variant; } SPDVoice;
typedef struct { char *inet_hostname; int port; char *unix_socket_name; int method; } SPDConnectionAddress;

/* ── Connection ────────────────────────────────────────────────────── */
SPDConnection *spd_open(const char *a, const char *b, const char *c, SPDConnectionMode m)
    { (void)a;(void)b;(void)c;(void)m; return NULL; }
SPDConnection *spd_open2(const char *a, const char *b, const char *c, SPDConnectionMode m,
                          SPDConnectionAddress *addr, int spawn, char **err)
    { (void)a;(void)b;(void)c;(void)m;(void)addr;(void)spawn; if(err)*err=NULL; return NULL; }
int  spd_close(SPDConnection *c)                                          { (void)c; return -1; }
int  spd_get_client_id(SPDConnection *c)                                  { (void)c; return -1; }
int  spd_fd(SPDConnection *c)                                             { (void)c; return -1; }
SPDConnectionAddress *spd_get_default_address(char **err)
    { if(err)*err=NULL; return NULL; }
void SPDConnectionAddress__free(SPDConnectionAddress *a)                  { (void)a; }

/* ── Speech output ─────────────────────────────────────────────────── */
int  spd_say(SPDConnection *c, SPDPriority p, const char *t)              { (void)c;(void)p;(void)t; return -1; }
int  spd_sayf(SPDConnection *c, SPDPriority p, const char *fmt, ...)      { (void)c;(void)p;(void)fmt; return -1; }
int  spd_key(SPDConnection *c, SPDPriority p, const char *k)              { (void)c;(void)p;(void)k; return -1; }
int  spd_char(SPDConnection *c, SPDPriority p, const char *ch)            { (void)c;(void)p;(void)ch; return -1; }
int  spd_wchar(SPDConnection *c, SPDPriority p, wchar_t wch)              { (void)c;(void)p;(void)wch; return -1; }
int  spd_sound_icon(SPDConnection *c, SPDPriority p, const char *i)       { (void)c;(void)p;(void)i; return -1; }

/* ── Flow control ──────────────────────────────────────────────────── */
int  spd_stop(SPDConnection *c)                                            { (void)c; return -1; }
int  spd_stop_all(SPDConnection *c)                                        { (void)c; return -1; }
int  spd_stop_uid(SPDConnection *c, int uid)                               { (void)c;(void)uid; return -1; }
int  spd_cancel(SPDConnection *c)                                          { (void)c; return -1; }
int  spd_cancel_all(SPDConnection *c)                                      { (void)c; return -1; }
int  spd_cancel_uid(SPDConnection *c, int uid)                             { (void)c;(void)uid; return -1; }
int  spd_pause(SPDConnection *c)                                           { (void)c; return -1; }
int  spd_pause_all(SPDConnection *c)                                       { (void)c; return -1; }
int  spd_pause_uid(SPDConnection *c, int uid)                              { (void)c;(void)uid; return -1; }
int  spd_resume(SPDConnection *c)                                          { (void)c; return -1; }
int  spd_resume_all(SPDConnection *c)                                      { (void)c; return -1; }
int  spd_resume_uid(SPDConnection *c, int uid)                             { (void)c;(void)uid; return -1; }

/* ── Low-level data/command ────────────────────────────────────────── */
int  spd_send_data(SPDConnection *c, const char *d, int recv)             { (void)c;(void)d;(void)recv; return -1; }
int  spd_send_data_wo_mutex(SPDConnection *c, const char *d, int recv)    { (void)c;(void)d;(void)recv; return -1; }
char *spd_execute_command(SPDConnection *c, const char *cmd)              { (void)c;(void)cmd; return NULL; }
char *spd_execute_command_with_reply(SPDConnection *c, const char *cmd, char **data)
    { (void)c;(void)cmd;(void)data; return NULL; }
int  spd_execute_command_with_list_reply(SPDConnection *c, const char *cmd, char ***data)
    { (void)c;(void)cmd;(void)data; return -1; }
int  spd_execute_command_wo_mutex(SPDConnection *c, const char *cmd)      { (void)c;(void)cmd; return -1; }
int  spd_get_message_list_fd(SPDConnection *c, int fd, int *nfds, char *event_id)
    { (void)c;(void)fd;(void)nfds;(void)event_id; return -1; }

/* ── Voice / module queries ────────────────────────────────────────── */
char     **spd_list_modules(SPDConnection *c)                              { (void)c; return NULL; }
char     **spd_list_voices(SPDConnection *c)                               { (void)c; return NULL; }
SPDVoice **spd_list_synthesis_voices(SPDConnection *c)                     { (void)c; return NULL; }
SPDVoice **spd_list_synthesis_voices2(SPDConnection *c, const char *l, const char *m)
    { (void)c;(void)l;(void)m; return NULL; }
char      *spd_get_output_module(SPDConnection *c)                         { (void)c; return NULL; }
char      *spd_get_language(SPDConnection *c)                              { (void)c; return NULL; }
int        spd_get_voice_rate(SPDConnection *c)                            { (void)c; return -1; }
int        spd_get_voice_pitch(SPDConnection *c)                           { (void)c; return -1; }
int        spd_get_volume(SPDConnection *c)                                { (void)c; return -1; }
int        spd_get_voice_type(SPDConnection *c)                            { (void)c; return -1; }

/* ── Free helpers ──────────────────────────────────────────────────── */
void free_spd_voices(SPDVoice **v)                                         { (void)v; }
void free_spd_symbolic_voices(char **v)                                    { (void)v; }
void free_spd_modules(char **v)                                            { (void)v; }
void spd_free_synthesis_voices(SPDVoice **v)                               { (void)v; }

/* ── Setters (self) ────────────────────────────────────────────────── */
int  spd_set_voice_rate(SPDConnection *c, int r)                           { (void)c;(void)r; return -1; }
int  spd_set_voice_pitch(SPDConnection *c, int p)                          { (void)c;(void)p; return -1; }
int  spd_set_voice_pitch_range(SPDConnection *c, int r)                    { (void)c;(void)r; return -1; }
int  spd_set_volume(SPDConnection *c, int v)                               { (void)c;(void)v; return -1; }
int  spd_set_voice_type(SPDConnection *c, SPDVoiceType t)                  { (void)c;(void)t; return -1; }
int  spd_set_synthesis_voice(SPDConnection *c, const char *v)              { (void)c;(void)v; return -1; }
int  spd_set_data_mode(SPDConnection *c, SPDDataMode m)                    { (void)c;(void)m; return -1; }
int  spd_set_notification_on(SPDConnection *c, SPDNotification n)          { (void)c;(void)n; return -1; }
int  spd_set_notification_off(SPDConnection *c, SPDNotification n)         { (void)c;(void)n; return -1; }
int  spd_set_notification(SPDConnection *c, SPDNotification n, const char *state)
    { (void)c;(void)n;(void)state; return -1; }
int  spd_set_notification_paused(SPDConnection *c, SPDNotification n)      { (void)c;(void)n; return -1; }
int  spd_set_spelling(SPDConnection *c, SPDSpelling s)                     { (void)c;(void)s; return -1; }
int  spd_set_punctuation(SPDConnection *c, SPDPunctuation p)               { (void)c;(void)p; return -1; }
int  spd_set_capital_letters(SPDConnection *c, SPDCapitalLetters l)        { (void)c;(void)l; return -1; }
int  spd_set_language(SPDConnection *c, const char *l)                     { (void)c;(void)l; return -1; }
int  spd_set_output_module(SPDConnection *c, const char *m)                { (void)c;(void)m; return -1; }

/* ── Setters (_all) ────────────────────────────────────────────────── */
int  spd_set_voice_rate_all(SPDConnection *c, int r)                       { (void)c;(void)r; return -1; }
int  spd_set_voice_pitch_all(SPDConnection *c, int p)                      { (void)c;(void)p; return -1; }
int  spd_set_voice_pitch_range_all(SPDConnection *c, int r)                { (void)c;(void)r; return -1; }
int  spd_set_volume_all(SPDConnection *c, int v)                           { (void)c;(void)v; return -1; }
int  spd_set_voice_type_all(SPDConnection *c, SPDVoiceType t)              { (void)c;(void)t; return -1; }
int  spd_set_synthesis_voice_all(SPDConnection *c, const char *v)          { (void)c;(void)v; return -1; }
int  spd_set_spelling_all(SPDConnection *c, SPDSpelling s)                 { (void)c;(void)s; return -1; }
int  spd_set_punctuation_all(SPDConnection *c, SPDPunctuation p)           { (void)c;(void)p; return -1; }
int  spd_set_capital_letters_all(SPDConnection *c, SPDCapitalLetters l)    { (void)c;(void)l; return -1; }
int  spd_set_language_all(SPDConnection *c, const char *l)                 { (void)c;(void)l; return -1; }
int  spd_set_output_module_all(SPDConnection *c, const char *m)            { (void)c;(void)m; return -1; }

/* ── Setters (_uid) ────────────────────────────────────────────────── */
int  spd_set_voice_rate_uid(SPDConnection *c, int r, int uid)              { (void)c;(void)r;(void)uid; return -1; }
int  spd_set_voice_pitch_uid(SPDConnection *c, int p, int uid)             { (void)c;(void)p;(void)uid; return -1; }
int  spd_set_voice_pitch_range_uid(SPDConnection *c, int r, int uid)       { (void)c;(void)r;(void)uid; return -1; }
int  spd_set_volume_uid(SPDConnection *c, int v, int uid)                  { (void)c;(void)v;(void)uid; return -1; }
int  spd_set_voice_type_uid(SPDConnection *c, SPDVoiceType t, int uid)     { (void)c;(void)t;(void)uid; return -1; }
int  spd_set_synthesis_voice_uid(SPDConnection *c, const char *v, int uid) { (void)c;(void)v;(void)uid; return -1; }
int  spd_set_spelling_uid(SPDConnection *c, SPDSpelling s, int uid)        { (void)c;(void)s;(void)uid; return -1; }
int  spd_set_punctuation_uid(SPDConnection *c, SPDPunctuation p, int uid)  { (void)c;(void)p;(void)uid; return -1; }
int  spd_set_capital_letters_uid(SPDConnection *c, SPDCapitalLetters l, int uid)
    { (void)c;(void)l;(void)uid; return -1; }
int  spd_set_language_uid(SPDConnection *c, const char *l, int uid)        { (void)c;(void)l;(void)uid; return -1; }
int  spd_set_output_module_uid(SPDConnection *c, const char *m, int uid)   { (void)c;(void)m;(void)uid; return -1; }

/* ── Wide-char setters ─────────────────────────────────────────────── */
int  spd_w_set_voice_type(SPDConnection *c, const wchar_t *t)              { (void)c;(void)t; return -1; }
int  spd_w_set_punctuation(SPDConnection *c, const wchar_t *p)             { (void)c;(void)p; return -1; }
int  spd_w_set_spelling(SPDConnection *c, const wchar_t *s)                { (void)c;(void)s; return -1; }
int  spd_w_set_capital_letters(SPDConnection *c, const wchar_t *l)         { (void)c;(void)l; return -1; }

/* ── Callbacks ─────────────────────────────────────────────────────── */
void spd_set_callback_begin(SPDConnection *c, SPDCallback cb)              { (void)c;(void)cb; }
void spd_set_callback_end(SPDConnection *c, SPDCallback cb)                { (void)c;(void)cb; }
void spd_set_callback_cancel(SPDConnection *c, SPDCallback cb)             { (void)c;(void)cb; }
void spd_set_callback_pause(SPDConnection *c, SPDCallback cb)              { (void)c;(void)cb; }
void spd_set_callback_resume(SPDConnection *c, SPDCallback cb)             { (void)c;(void)cb; }
