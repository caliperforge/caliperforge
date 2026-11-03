use jsonrpc_core::{BoxFuture, Result};
use jsonrpc_derive::rpc;

#[rpc]
pub trait SurfnetCheatcodes {
    type Metadata;

    #[rpc(meta, name = "surfnet_setAccount")]
    fn set_account(
        &self,
        meta: Self::Metadata,
        pubkey_str: String,
        update: AccountUpdate,
    ) -> BoxFuture<Result<RpcResponse<()>>>;

    #[rpc(meta, name = "surfnet_timeTravel")]
    fn time_travel(&self, meta: Self::Metadata, config: Option<TimeTravelConfig>) -> Result<EpochInfo>;
}
