import sys

# PATCH_REG_EVENT_SUBSCRIBE: subscribe to the IMS "reg" event package after every successful
# REGISTER, like a native UE (3GPP TS 24.229 5.1.1.3), and answer the resulting NOTIFYs.
#
# The stock sysmocom VoLTE client registers but never sends SUBSCRIBE (Event: reg). Most IMS
# cores don't care (Telefonica DE works without it), but stricter P-CSCFs treat a UE without a
# reg-event subscription as not fully registered: MTS RU (Nokia/Lucent P-CSCF) accepts the
# REGISTER with 200 OK and then rejects every originating INVITE with
# "403 Forbidden - 4003 User not registered", while iPhone/Android on the same SIM call fine.
#
# What this adds to res_pjsip_outbound_registration.c:
#   1. volte_send_reg_subscribe(): after each 200 OK to a (re-)REGISTER, send
#      SUBSCRIBE <default IMPU> with Event: reg, Accept: application/reginfo+xml,
#      Expires: 600000, routed exactly like the MO SMS path (Service-Route as Route,
#      Security-Verify, sec-agree, P-Access-Network-Info, P-Preferred-Identity) so it
#      leaves over the protected IPsec port. Re-sent on every re-registration instead of an
#      in-dialog refresh (the registration refresh interval is always shorter than the
#      subscription lifetime the S-CSCF grants, which TS 24.229 caps at the registration's).
#   2. A tiny PJSIP module, ahead of Asterisk's distributor, that answers incoming
#      NOTIFY (Event: reg) with a stateless 200 OK. Without it Asterisk would answer 481
#      (no matching dialog: the SUBSCRIBE is sent out of dialog), and the S-CSCF would
#      terminate the subscription again.
#   3. The state/event of the first <contact> in each NOTIFY's reginfo body is stored in
#      Asterisk's astdb (family "volte", key "reginfo", e.g. "terminated;rejected"), reset to
#      "subscribed;none" on every new SUBSCRIBE. Asterisk itself keeps reporting the outbound
#      registration as Registered when the network removes it (MTS: event="rejected" ~220 ms
#      after the 200 OK), so the control plane reads this key to show the real state.

HELPERS = r'''
/* PATCH_REG_EVENT_SUBSCRIBE */
static void volte_reg_subscribe_cb(void *token, pjsip_event *e)
{
	if (e->type == PJSIP_EVENT_TSX_STATE && e->body.tsx_state.tsx) {
		ast_log(LOG_NOTICE, "VoLTE: reg-event SUBSCRIBE answered %d\n",
			e->body.tsx_state.tsx->status_code);
	}
}

#define VOLTE_REGINFO_DB_FAMILY "volte"
#define VOLTE_REGINFO_DB_KEY "reginfo"

/* Copy the value of attribute name="..." found inside [start, end) into out. */
static void volte_reginfo_attr(const char *start, const char *end, const char *name, char *out, size_t len)
{
	char needle[32];
	const char *p, *q;

	ast_copy_string(out, "none", len);
	snprintf(needle, sizeof(needle), " %s=\"", name);
	p = strstr(start, needle);
	if (!p || p >= end) {
		return;
	}
	p += strlen(needle);
	q = strchr(p, '"');
	if (!q || q > end || (size_t) (q - p) >= len) {
		return;
	}
	memcpy(out, p, q - p);
	out[q - p] = '\0';
}

/* Store "<state>;<event>" of the first <contact> of a reginfo NOTIFY body in astdb. */
static void volte_store_reginfo(pjsip_rx_data *rdata)
{
	pjsip_msg_body *body = rdata->msg_info.msg->body;
	char *xml, *contact, *tag_end;
	char state[32], event[32], value[72];

	if (!body || !body->len || !body->data) {
		return;
	}
	xml = ast_strndup(body->data, body->len);
	if (!xml) {
		return;
	}
	contact = strstr(xml, "<contact ");
	tag_end = contact ? strchr(contact, '>') : NULL;
	if (contact && tag_end) {
		volte_reginfo_attr(contact, tag_end, "state", state, sizeof(state));
		volte_reginfo_attr(contact, tag_end, "event", event, sizeof(event));
		snprintf(value, sizeof(value), "%s;%s", state, event);
		ast_db_put(VOLTE_REGINFO_DB_FAMILY, VOLTE_REGINFO_DB_KEY, value);
		if (!strcmp(state, "terminated")) {
			ast_log(LOG_WARNING, "VoLTE: network terminated our IMS registration (contact event=%s)\n", event);
		}
	}
	ast_free(xml);
}

static void volte_send_reg_subscribe(struct sip_outbound_registration_client_state *client_state)
{
	struct ast_sip_endpoint *endpoint = NULL;
	struct ast_sip_transport_state *transport_state = NULL;
	pjsip_tx_data *tdata;
	char impu[sizeof(((struct ast_sip_transport_state *)0)->volte.p_associated_uri)];
	char bracket_impu[sizeof(impu) + 2];

	if (get_endpoint_transport_transport_state(client_state, &endpoint, NULL, &transport_state)) {
		goto out;
	}

	ao2_lock(transport_state);
	ast_copy_string(impu, transport_state->volte.p_associated_uri, sizeof(impu));
	ao2_unlock(transport_state);
	if (ast_strlen_zero(impu)) {
		ast_log(LOG_WARNING, "VoLTE: no registered IMPU, not sending reg-event SUBSCRIBE\n");
		goto out;
	}

	if (ast_sip_create_request("SUBSCRIBE", NULL, endpoint, impu, NULL, &tdata)) {
		ast_log(LOG_WARNING, "VoLTE: could not create reg-event SUBSCRIBE\n");
		goto out;
	}

	ao2_lock(transport_state);
	if (transport_state->service_routes) {
		int idx;

		for (idx = 0; idx < AST_VECTOR_SIZE(transport_state->service_routes); ++idx) {
			ast_sip_add_header(tdata, "Route", AST_VECTOR_GET(transport_state->service_routes, idx));
		}
	}
	ast_sip_add_header(tdata, "Security-Verify", transport_state->volte.security_server);
	if (transport_state->volte.p_access_network_info[0]) {
		ast_sip_add_header(tdata, "P-Access-Network-Info", transport_state->volte.p_access_network_info);
	}
	ao2_unlock(transport_state);

	ast_sip_add_header(tdata, "Require", "sec-agree");
	ast_sip_add_header(tdata, "Proxy-Require", "sec-agree");
	ast_sip_add_header(tdata, "Supported", "path, sec-agree");
	snprintf(bracket_impu, sizeof(bracket_impu), "<%s>", impu);
	ast_sip_add_header(tdata, "P-Preferred-Identity", bracket_impu);
	ast_sip_update_from(tdata, impu);
	ast_sip_add_header(tdata, "Event", "reg");
	ast_sip_add_header(tdata, "Accept", "application/reginfo+xml");
	/* TS 24.229 5.1.1.3: the UE sets Expires to 600000; the S-CSCF shortens it. */
	ast_sip_add_header(tdata, "Expires", "600000");

	/* New registration: forget the previous one's reginfo state until the first NOTIFY. */
	ast_db_put(VOLTE_REGINFO_DB_FAMILY, VOLTE_REGINFO_DB_KEY, "subscribed;none");
	if (ast_sip_send_request(tdata, NULL, endpoint, NULL, volte_reg_subscribe_cb)) {
		ast_log(LOG_WARNING, "VoLTE: could not send reg-event SUBSCRIBE\n");
	} else {
		ast_log(LOG_NOTICE, "VoLTE: sent reg-event SUBSCRIBE for %s\n", impu);
	}

out:
	ao2_cleanup(endpoint);
	ao2_cleanup(transport_state);
}

/* Answer NOTIFY (Event: reg) for our out-of-dialog reg-event subscription with 200 OK. */
static pj_bool_t volte_reg_notify_on_rx_request(pjsip_rx_data *rdata)
{
	static const pj_str_t STR_EVENT = { "Event", 5 };
	static const pj_str_t STR_EVENT_SHORT = { "o", 1 };
	pjsip_generic_string_hdr *event;
	pj_str_t *method = &rdata->msg_info.msg->line.req.method.name;

	if (pj_stricmp2(method, "NOTIFY")) {
		return PJ_FALSE;
	}
	event = (pjsip_generic_string_hdr *) pjsip_msg_find_hdr_by_names(rdata->msg_info.msg,
		&STR_EVENT, &STR_EVENT_SHORT, NULL);
	if (!event || event->hvalue.slen < 3 || pj_strnicmp2(&event->hvalue, "reg", 3)
		|| (event->hvalue.slen > 3 && event->hvalue.ptr[3] != ';' && event->hvalue.ptr[3] != ' ')) {
		return PJ_FALSE;
	}
	ast_log(LOG_NOTICE, "VoLTE: answering reg-event NOTIFY with 200 OK\n");
	volte_store_reginfo(rdata);
	pjsip_endpt_respond_stateless(ast_sip_get_pjsip_endpoint(), rdata, 200, NULL, NULL, NULL);
	return PJ_TRUE;
}

static pjsip_module volte_reg_notify_module = {
	.name = { "VoLTE reg-event NOTIFY", 22 },
	/* Ahead of Asterisk's distributor (PJSIP_MOD_PRIORITY_TSX_LAYER - 6). */
	.priority = PJSIP_MOD_PRIORITY_TSX_LAYER - 7,
	.on_rx_request = volte_reg_notify_on_rx_request,
};

'''

f = '/home/asterisk-build/asterisk/res/res_pjsip_outbound_registration.c'
s = open(f).read()
if 'PATCH_REG_EVENT_SUBSCRIBE' in s:
    print("already patched"); sys.exit(0)


def replace_once(s, old, new, what):
    n = s.count(old)
    if n != 1:
        print("PATTERN NOT FOUND (%d matches): %s" % (n, what)); sys.exit(1)
    return s.replace(old, new)


s = replace_once(s, '#include "asterisk/pbx.h"\n',
                 '#include "asterisk/pbx.h"\n#include "asterisk/astdb.h"\n',
                 'pbx.h include')
s = replace_once(s, 'static int handle_registration_response(void *data)\n',
                 HELPERS + 'static int handle_registration_response(void *data)\n',
                 'handle_registration_response definition')
s = replace_once(s,
                 '\t\tsave_response_fields_to_transport(response);\n'
                 '\t\tif (response->client_state->volte)\n'
                 '\t\t\tstore_volte_p_associated_uri(response);\n',
                 '\t\tsave_response_fields_to_transport(response);\n'
                 '\t\tif (response->client_state->volte)\n'
                 '\t\t\tstore_volte_p_associated_uri(response);\n'
                 '\t\tif (response->client_state->volte && response->expiration)\n'
                 '\t\t\tvolte_send_reg_subscribe(response->client_state);\n',
                 '200 OK p_associated_uri store')
s = replace_once(s, '\tast_sip_register_endpoint_identifier(&line_identifier);\n',
                 '\tast_sip_register_endpoint_identifier(&line_identifier);\n'
                 '\tast_sip_register_service(&volte_reg_notify_module);\n',
                 'load_module endpoint identifier registration')
s = replace_once(s, '\tnetwork_change_sub = stasis_unsubscribe_and_join(network_change_sub);\n',
                 '\tnetwork_change_sub = stasis_unsubscribe_and_join(network_change_sub);\n'
                 '\tast_sip_unregister_service(&volte_reg_notify_module);\n',
                 'unload_module unsubscribe')
open(f, 'w').write(s)
print("patched OK (reg-event SUBSCRIBE + NOTIFY responder)")
