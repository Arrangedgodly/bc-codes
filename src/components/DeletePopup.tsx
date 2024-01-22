const DeletePopup = ({ deleteRelease }: any) => {
  return (
    <>
    <input type="checkbox" id="delete_release" className="modal-toggle" />
      <div className="modal" role="dialog">
        <div className="modal-box glass">
          <h3 className="text-5xl font-bold text-center">Are you sure you want to delete this release?</h3>
          <p className="text-2xl text-center">This action cannot be undone.</p>
          <div className="modal-action">
            <label htmlFor="delete_release" className="btn btn-primary btn-lg text-xl">
              Cancel
            </label>
            <label htmlFor="delete_release" className="btn btn-error btn-lg text-xl" onClick={deleteRelease}>
              Delete
            </label>
          </div>
        </div>
        <label className="modal-backdrop" htmlFor="delete_release">
          Close
        </label>
      </div>
    </>
  )
}

export default DeletePopup;