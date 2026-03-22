CONTIKI_PROJECT = websense
all: $(CONTIKI_PROJECT)

CONTIKI = /Users/vasil/contiki-ng
PROJECT_SOURCEFILES += websense.c

MODULES += os/net/ipv6/tcp-socket
include $(CONTIKI)/Makefile.include