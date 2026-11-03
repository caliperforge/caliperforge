use jsonrpc_core::{BoxFuture, Result};
use jsonrpc_derive::rpc;

#[rpc]
pub trait Full {
    type Metadata;

    #[rpc(meta, name = "getAccountInfo")]
    fn get_account_info(
        &self,
        meta: Self::Metadata,
        pubkey_str: String,
        config: Option<RpcAccountInfoConfig>,
    ) -> BoxFuture<Result<RpcResponse<Option<UiAccount>>>>;

    #[rpc(name = "getHealth")]
    /// Returns "ok" when the fn below can serve (u64, String) requests.
    fn get_health(&self) -> Result<String>;

    #[rpc(meta, name = "getMultipleAccounts")]
    fn get_multiple_accounts(
        &self,
        meta: Self::Metadata,
        pubkey_strs: Vec<String>,
        config: Option<RpcAccountInfoConfig>,
    ) -> BoxFuture<Result<RpcResponse<Vec<Option<UiAccount>>>>>;

    #[rpc(meta, name = "getNewThing")]
    fn get_new_thing(&self, meta: Self::Metadata, thing: RpcNewThing) -> BoxFuture<Result<u64>>;

    #[rpc(meta, name = "getTransaction")]
    fn get_transaction(
        &self,
        meta: Self::Metadata,
        signature_str: String,
        config: Option<RpcEncodingConfigWrapper<RpcTransactionConfig>>,
    ) -> BoxFuture<Result<Option<EncodedConfirmedTransactionWithStatusMeta>>>;
}
