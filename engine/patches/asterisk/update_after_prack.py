import sys

# PATCH_UPDATE_AFTER_PRACK: on an outgoing VoLTE call with preconditions, send the UPDATE that
# reports our local QoS as met only after the PRACK for the reliable 183 has been answered.
#
# Stock behaviour: when the 183 Session Progress (reliable, RSeq) arrives and the dedicated
# bearer is already up, res_pjsip_session sends the UPDATE immediately, while PJSIP's 100rel
# module sends the PRACK for that same 183 -- the two go out back to back. A Nokia P-CSCF
# (MTS RU) still processing the PRACK answers the UPDATE with "491 Request Pending" and then
# ends the INVITE with "500 Server Internal Error" (Q.850 cause 47) because the precondition
# never completes. RFC 3312's flows (and native UEs) send the UPDATE after the 200 OK to PRACK.
#
# Opt-in per line through the engine environment (VOWIFI_UPDATE_AFTER_PRACK=1), like
# reg_extras: lines without it keep the stock timing.

STATE_ENUM_OLD = '\tAST_SIP_SESSION_PRECONDITION_MT_COMPLETE,\n};\n'
STATE_ENUM_NEW = ('\tAST_SIP_SESSION_PRECONDITION_MT_COMPLETE,\n'
                  '\t/* PATCH_UPDATE_AFTER_PRACK: UPDATE deferred until the 183 PRACK is answered */\n'
                  '\tAST_SIP_SESSION_PRECONDITION_MO_WAIT_PRACK,\n};\n')

PROGRESS_OLD = '''		} else if (session->dedicated_bearer_up) {
			/* AMI already reported that dedicated bearer is up */
			/* Send UPDATE now and enter MO_UPDATE state. */
			ast_debug(1, "%s: Precondition state is waiting for UPDATE to complete.\\n",
				  ast_sip_session_get_name(session));
			session_precondition_send_update(session);
'''
PROGRESS_NEW = '''		} else if (session->dedicated_bearer_up) {
			/* AMI already reported that dedicated bearer is up */
			static const pj_str_t STR_RSEQ = { "RSeq", 4 };
			const char *after_prack = getenv("VOWIFI_UPDATE_AFTER_PRACK");

			if (!ast_strlen_zero(after_prack) && strcmp(after_prack, "0")
				&& pjsip_msg_find_hdr_by_name(rdata->msg_info.msg, &STR_RSEQ, NULL)) {
				/* PATCH_UPDATE_AFTER_PRACK: reliable 183 -> PJSIP is sending its PRACK now;
				 * send the UPDATE once that PRACK is answered (session_on_rx_response). */
				ast_debug(1, "%s: Precondition state is waiting for PRACK response before UPDATE.\\n",
					  ast_sip_session_get_name(session));
				session->precondition_state = AST_SIP_SESSION_PRECONDITION_MO_WAIT_PRACK;
			} else {
				/* Send UPDATE now and enter MO_UPDATE state. */
				ast_debug(1, "%s: Precondition state is waiting for UPDATE to complete.\\n",
					  ast_sip_session_get_name(session));
				session_precondition_send_update(session);
			}
'''

HELPER = r'''
/* PATCH_UPDATE_AFTER_PRACK: runs on the session serializer once the PRACK is answered. */
static int session_precondition_update_after_prack(void *data)
{
	struct ast_sip_session *session = data;

	if (session->precondition_state == AST_SIP_SESSION_PRECONDITION_MO_WAIT_PRACK) {
		ast_debug(1, "%s: PRACK answered, sending precondition UPDATE.\n",
			  ast_sip_session_get_name(session));
		session_precondition_send_update(session);
	}
	ao2_ref(session, -1);
	return 0;
}

'''

RX_OLD = '''		(int)rdata->msg_info.cseq->method.name.slen, rdata->msg_info.cseq->method.name.ptr, status.code);

	SCOPE_EXIT_RTN_VALUE(PJ_FALSE);
'''
RX_NEW = '''		(int)rdata->msg_info.cseq->method.name.slen, rdata->msg_info.cseq->method.name.ptr, status.code);

	/* PATCH_UPDATE_AFTER_PRACK: final response to our PRACK -> now send the deferred UPDATE
	 * (also on an error response, so the call can never hang in this state). */
	if (session && status.code >= 200
		&& session->precondition_state == AST_SIP_SESSION_PRECONDITION_MO_WAIT_PRACK
		&& !pj_strcmp2(&rdata->msg_info.cseq->method.name, "PRACK")) {
		ao2_ref(session, +1);
		if (ast_sip_push_task(session->serializer, session_precondition_update_after_prack, session)) {
			ao2_ref(session, -1);
		}
	}

	SCOPE_EXIT_RTN_VALUE(PJ_FALSE);
'''


def replace_once(s, old, new, what):
    n = s.count(old)
    if n != 1:
        print("PATTERN NOT FOUND (%d matches): %s" % (n, what)); sys.exit(1)
    return s.replace(old, new)


hdr = '/home/asterisk-build/asterisk/include/asterisk/res_pjsip_session.h'
s = open(hdr).read()
if 'PATCH_UPDATE_AFTER_PRACK' not in s:
    s = replace_once(s, STATE_ENUM_OLD, STATE_ENUM_NEW, 'precondition state enum')
    open(hdr, 'w').write(s)

src = '/home/asterisk-build/asterisk/res/res_pjsip_session.c'
s = open(src).read()
if 'PATCH_UPDATE_AFTER_PRACK' not in s:
    s = replace_once(s, PROGRESS_OLD, PROGRESS_NEW, '183 precondition UPDATE send')
    s = replace_once(s, 'static int session_precondition_timeout(void *data)\n',
                     HELPER + 'static int session_precondition_timeout(void *data)\n',
                     'session_precondition_timeout definition')
    s = replace_once(s, RX_OLD, RX_NEW, 'session_on_rx_response body')
    open(src, 'w').write(s)

print("patched OK (precondition UPDATE after PRACK response, env-switchable)")
