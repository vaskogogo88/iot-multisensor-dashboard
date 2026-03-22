#include "contiki.h"
#include "contiki-net.h"

#include "net/ipv6/tcp-socket.h"
#include "lib/random.h"

#include <stdio.h>
#include <string.h>
#include <stdbool.h>

#define HTTP_PORT 80

static uint8_t inbuf[256];
static uint8_t outbuf[600];

static struct tcp_socket sock;

static bool busy = false;

typedef struct {
  bool replied;
  bool pending_close;
  int  response_len;
} conn_state_t;

static conn_state_t st;

static int input_callback(struct tcp_socket *s, void *ptr,
                          const uint8_t *input_data_ptr, int input_data_len);
static void event_callback(struct tcp_socket *s, void *ptr, tcp_socket_event_t event);

static int
find_header_end(const char *buf)
{
  const char *p = strstr(buf, "\r\n\r\n");
  if(p) return (int)(p - buf) + 4;
  p = strstr(buf, "\n\n");
  if(p) return (int)(p - buf) + 2;
  return -1;
}

static void
send_json(struct tcp_socket *s, int code, const char *json_body)
{
  const char *status = (code == 200) ? "200 OK" : "404 Not Found";
  int body_len = (int)strlen(json_body);

  st.response_len = snprintf((char *)outbuf, sizeof(outbuf),
                             "HTTP/1.1 %s\r\n"
                             "Server: Contiki-NG\r\n"
                             "Content-Type: application/json\r\n"
                             "Cache-Control: no-cache\r\n"
                             "Connection: close\r\n"
                             "Content-Length: %d\r\n"
                             "\r\n"
                             "%s",
                             status, body_len, json_body);

  if(st.response_len < 0) st.response_len = 0;
  if(st.response_len > (int)sizeof(outbuf)) st.response_len = (int)sizeof(outbuf);

  st.pending_close = true;
  tcp_socket_send(s, outbuf, st.response_len);
}

/* --- Callbacks --- */
static int
input_callback(struct tcp_socket *s, void *ptr,
               const uint8_t *input_data_ptr, int input_data_len)
{
  (void)ptr;

  if(st.replied) {
    return 0;
  }

  char req[300];
  int n = input_data_len;
  if(n > (int)sizeof(req) - 1) n = (int)sizeof(req) - 1;

  memcpy(req, input_data_ptr, n);
  req[n] = '\0';

  if(find_header_end(req) < 0) {
    return input_data_len;
  }

  char *line_end = strstr(req, "\r\n");
  if(line_end == NULL) line_end = strstr(req, "\n");
  if(line_end != NULL) *line_end = '\0';

  if(strncmp(req, "GET ", 4) == 0) {
    const char *path = req + 4;
    const char *sp = strchr(path, ' ');
    if(sp != NULL) {
      int path_len = (int)(sp - path);

      if(path_len == 5 && strncmp(path, "/temp", 5) == 0) {
        uint16_t r = random_rand();
        int temp_x10 = 180 + (r % 121); /* 18.0..30.0 */
        int temp_int = temp_x10 / 10;
        int temp_dec = temp_x10 % 10;

        char json[128];
        snprintf(json, sizeof(json),
                 "{\"temperature\": %d.%d, \"unit\": \"C\"}\n",
                 temp_int, temp_dec);

        st.replied = true;
        send_json(s, 200, json);
        return 0;
      }
    }
  }

  st.replied = true;
  send_json(s, 404, "{\"error\":\"not found\"}\n");
  return 0;
}

static void
event_callback(struct tcp_socket *s, void *ptr, tcp_socket_event_t event)
{
  (void)ptr;

  switch(event) {
  case TCP_SOCKET_CONNECTED:

    if(busy) {
      tcp_socket_close(s);
      return;
    }
    busy = true;
    st.replied = false;
    st.pending_close = false;
    st.response_len = 0;
    break;

  case TCP_SOCKET_DATA_SENT:
    if(st.pending_close) {
      st.pending_close = false;
      tcp_socket_close(s);
    }
    break;

  case TCP_SOCKET_CLOSED:
  case TCP_SOCKET_ABORTED:
  case TCP_SOCKET_TIMEDOUT:
    busy = false;
    st.replied = false;
    st.pending_close = false;
    st.response_len = 0;
    break;

  default:
    break;
  }
}

PROCESS(random_temp_http_server_process, "Random Temp HTTP Server");
AUTOSTART_PROCESSES(&random_temp_http_server_process);

PROCESS_THREAD(random_temp_http_server_process, ev, data)
{
  PROCESS_BEGIN();

  random_init();

  tcp_socket_register(&sock, NULL,
                      inbuf, sizeof(inbuf),
                      outbuf, sizeof(outbuf),
                      input_callback, event_callback);

  tcp_socket_listen(&sock, HTTP_PORT);

  printf("HTTP server listening on port %u (GET /temp)\n", HTTP_PORT);

  while(1) {
    PROCESS_YIELD();
  }

  PROCESS_END();
}